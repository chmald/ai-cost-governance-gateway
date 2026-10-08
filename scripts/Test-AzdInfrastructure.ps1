#Requires -Version 7.2
[CmdletBinding()]
param(
    [switch] $Restore
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$infra = Join-Path $root 'infra\azd'
$checks = 0

function Assert-Condition([bool] $Condition, [string] $Message) {
    if (-not $Condition) { throw $Message }
    $script:checks++
}

function Get-TemplateResources([System.Collections.IDictionary] $Template) {
    if (-not $Template.Contains('resources')) { return }
    $resources = if ($Template.resources -is [System.Collections.IDictionary]) {
        $Template.resources.Values
    } else { $Template.resources }
    foreach ($resource in $resources) {
        $resource
        if ($resource.type -eq 'Microsoft.Resources/deployments' -and
            $resource.properties.Contains('template')) {
            Get-TemplateResources $resource.properties.template
        }
    }
}

function Get-Resource($Resources, [string] $Type) {
    $matches = @($Resources | Where-Object type -EQ $Type)
    Assert-Condition ($matches.Count -eq 1) "Expected exactly one $Type, found $($matches.Count)."
    return $matches[0]
}

$null = Get-Command bicep -ErrorAction Stop
if ($Restore) {
    & bicep restore (Join-Path $infra 'main.bicep')
    Assert-Condition ($LASTEXITCODE -eq 0) 'Public AVM module restore failed.'
}

$templates = @{}
foreach ($file in Get-ChildItem -LiteralPath $infra -Filter '*.bicep' -Recurse) {
    # stdout avoids writing generated templates or credentials anywhere on disk.
    $json = & bicep build $file.FullName --stdout --no-restore
    Assert-Condition ($LASTEXITCODE -eq 0) "Bicep compilation failed: $($file.Name). Restore public modules with -Restore if missing."
    $templates[$file.BaseName] = ($json -join "`n") | ConvertFrom-Json -AsHashtable -Depth 100
}

foreach ($entry in @('main', 'gateway', 'migration-job')) {
    $parameterFile = Get-Content -LiteralPath (Join-Path $infra "$entry.parameters.json") -Raw |
        ConvertFrom-Json -AsHashtable
    Assert-Condition ($parameterFile.'$schema' -match 'deploymentParameters\.json#') "$entry must use ARM JSON parameters."
    $schema = $templates[$entry].parameters
    foreach ($name in $parameterFile.parameters.Keys) {
        Assert-Condition ($schema.Contains($name)) "$entry has an unknown parameter: $name."
        Assert-Condition ($parameterFile.parameters[$name].Contains('value')) "$entry/$name must be a nonsecret environment substitution."
        $value = $parameterFile.parameters[$name].value
        Assert-Condition ($value -is [string] -and $value -match '^\$\{[A-Z][A-Z0-9_]*(=[^}]*)?\}$') "$entry/$name must use azd environment substitution."
    }
    foreach ($name in $schema.Keys) {
        Assert-Condition ($schema[$name].Contains('defaultValue') -or $parameterFile.parameters.Contains($name)) "$entry is missing required parameter $name."
    }
    if ($entry -ne 'main') {
        Assert-Condition (-not $schema.imageName.Contains('defaultValue') -and $schema.imageName.minLength -ge 1) "$entry must require a nonempty image without any default."
        Assert-Condition ($parameterFile.parameters.imageName.value -ceq '${GATEWAY_DEPLOY_IMAGE}') "$entry must consume the same immutable digest resolved from the published gateway image by service predeploy."
    }
}

$main = $templates.main
$foundation = $templates.foundation
$all = @(Get-TemplateResources $main)
$foundationResources = @(Get-TemplateResources $foundation)
$gatewayResources = @(Get-TemplateResources $templates.gateway)
$jobResources = @(Get-TemplateResources $templates.'migration-job')
$foundationText = Get-Content -LiteralPath (Join-Path $infra 'modules\foundation.bicep') -Raw
$mainText = Get-Content -LiteralPath (Join-Path $infra 'main.bicep') -Raw

Assert-Condition ($main.'$schema' -match 'subscriptionDeploymentTemplate') 'The azd foundation must be subscription scoped.'
Assert-Condition (@($all | Where-Object { $_.type -in @('Microsoft.App/containerApps', 'Microsoft.App/jobs') }).Count -eq 0) 'Provision must never create an app revision, placeholder or executable migration job.'
Assert-Condition (@($all | Where-Object type -EQ 'Microsoft.CognitiveServices/accounts').Count -eq 0) 'Foundry must remain an existing account.'
Assert-Condition ($mainText.Contains("scope: resourceGroup(foundryResourceGroup)")) 'Foundry access must target its explicit existing RG in this subscription.'
Assert-Condition ($mainText.Contains("'../modules/foundry-access.bicep'")) 'Reuse the manual profile least-privilege Foundry module.'
Assert-Condition ($foundationText.Contains("'../../modules/gateway.bicep'")) 'Reuse the existing gateway policies without modifying the manual profile.'

$contract = Get-Content -LiteralPath (Join-Path $root 'docs\11-azd-integration-contract.md') -Raw
$outputSection = [regex]::Match($contract, '(?s)## Shared infrastructure outputs(.*?)## Application database authentication').Groups[1].Value
$requiredOutputs = @([regex]::Matches($outputSection, '`([A-Z][A-Z0-9_]+)`') | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique)
Assert-Condition ($requiredOutputs.Count -ge 25) 'Could not read the shared output contract.'
foreach ($name in $requiredOutputs) {
    Assert-Condition ($main.outputs.Contains($name)) "Missing shared contract output: $name."
}
Assert-Condition ($main.outputs.DATABASE_AUTH.value -eq 'entra' -and $main.outputs.POSTGRES_APP_ROLE.value -eq 'gateway_app') 'Database output contract changed.'
Assert-Condition ($foundation.outputs.databaseUrl.value -match 'postgresql://gateway_app@.*sslmode=verify-full') 'Runtime connection output must be passwordless and certificate verified.'
Assert-Condition ($foundation.outputs.gatewayUrl.value -match 'defaultDomain') 'Gateway URL must be derived from the environment default domain before the first revision.'
Assert-Condition ($main.outputs.SERVICE_GATEWAY_RESOURCE_ID.value -match 'Microsoft.App/containerApps') 'Return the deterministic future app ID without reading an app that does not yet exist.'

$rg = Get-Resource $all 'Microsoft.Resources/resourceGroups'
Assert-Condition ($main.variables.tags.'azd-env-name' -match 'environmentName' -and $rg.tags -match "variables\('tags'\)") 'Resource group must have azd-env-name.'

$postgres = Get-Resource $all 'Microsoft.DBforPostgreSQL/flexibleServers'
Assert-Condition ($postgres.properties.version -eq '17') 'PostgreSQL version must be 17.'
Assert-Condition ($postgres.properties.authConfig.activeDirectoryAuth -eq 'Enabled' -and $postgres.properties.authConfig.passwordAuth -eq 'Disabled') 'PostgreSQL must unconditionally be Entra-only.'
Assert-Condition (-not $postgres.properties.Contains('administratorLogin') -and -not $postgres.properties.Contains('administratorLoginPassword')) 'No database password or local administrator login may be emitted.'
Assert-Condition ($postgres.properties.network.publicNetworkAccess -eq 'Disabled') 'PostgreSQL public access must be disabled.'
Assert-Condition ($postgres.properties.network.delegatedSubnetResourceId -match 'subnets/postgres' -and $postgres.properties.network.privateDnsZoneArmResourceId -match 'privateDnsZones') 'Private PostgreSQL requires its own delegated subnet and DNS zone.'
Assert-Condition (@($all | Where-Object type -Match 'DBforPostgreSQL/.*/firewallRules').Count -eq 0) 'No public or all-Azure database firewall is allowed.'
$admin = Get-Resource $all 'Microsoft.DBforPostgreSQL/flexibleServers/administrators'
Assert-Condition ($admin.properties.principalType -eq 'ServicePrincipal') 'Migration administrator must be a service principal.'
$adminDeployment = @($foundationResources | Where-Object { $_.type -eq 'Microsoft.Resources/deployments' -and $_.name -eq 'postgres-entra-administrator' })[0]
Assert-Condition ($adminDeployment.properties.parameters.principalId.value -match 'migration-identity') 'Only migration identity can be PostgreSQL administrator.'
Assert-Condition ($adminDeployment.properties.parameters.principalName.value -match 'migration-identity') 'Administrator login must match the migration identity display name.'
$database = Get-Resource $all 'Microsoft.DBforPostgreSQL/flexibleServers/databases'
Assert-Condition (($database.dependsOn -join ' ') -match 'postgres-entra-administrator') 'Create the database after Entra administrator setup to preserve ownership ordering.'
$identityDeployments = @($foundationResources | Where-Object { $_.type -eq 'Microsoft.Resources/deployments' -and $_.name -in @('runtime-identity', 'migration-identity') })
Assert-Condition ($identityDeployments.Count -eq 2) 'Create distinct runtime and migration identities.'
Assert-Condition ($identityDeployments[0].properties.parameters.name.value -ne $identityDeployments[1].properties.parameters.name.value) 'Runtime and migration must never share an identity name.'

$registryDeployment = @($foundationResources | Where-Object { $_.type -eq 'Microsoft.Resources/deployments' -and $_.name -eq 'container-registry' })[0]
$acr = $registryDeployment.properties.parameters
Assert-Condition ($acr.acrSku.value -eq 'Basic' -and $acr.acrAdminUserEnabled.value -eq $false -and $acr.anonymousPullEnabled.value -eq $false) 'ACR must be Basic, with admin and anonymous pull disabled.'
Assert-Condition ($acr.roleAssignmentMode.value -eq 'LegacyRegistryPermissions' -and $acr.azureADAuthenticationAsArmPolicyStatus.value -eq 'enabled') 'AcrPull and ACA managed identity require registry RBAC and ARM token support.'
Assert-Condition ($acr.roleAssignments.value.Count -eq 2) 'Both managed identities require AcrPull.'
foreach ($assignment in $acr.roleAssignments.value) {
    Assert-Condition ($assignment.roleDefinitionIdOrName -eq 'AcrPull' -and $assignment.principalType -eq 'ServicePrincipal') 'Registry assignments must be AcrPull only.'
}
Assert-Condition (($acr.roleAssignments.value.principalId -join ' ') -match 'runtime-identity' -and ($acr.roleAssignments.value.principalId -join ' ') -match 'migration-identity') 'AcrPull must target each distinct identity.'

$network = Get-Resource $all 'Microsoft.Network/virtualNetworks'
$subnets = $network.properties.subnets
Assert-Condition ($subnets.Count -eq 2) 'ACA and PostgreSQL must use separate subnets.'
Assert-Condition ($subnets[0].properties.delegations[0].properties.serviceName -eq 'Microsoft.App/environments') 'Workload-profile ACA subnet needs Microsoft.App/environments delegation.'
Assert-Condition ($subnets[1].properties.delegations[0].properties.serviceName -eq 'Microsoft.DBforPostgreSQL/flexibleServers') 'PostgreSQL subnet needs its own delegation.'
$dnsLink = Get-Resource $all 'Microsoft.Network/privateDnsZones/virtualNetworkLinks'
Assert-Condition ($dnsLink.properties.registrationEnabled -eq $false -and $dnsLink.properties.virtualNetwork.id -match 'virtualNetworks') 'PostgreSQL private DNS must be linked to the shared VNet.'
$environment = Get-Resource $all 'Microsoft.App/managedEnvironments'
Assert-Condition ($environment.properties.workloadProfiles.Count -eq 1 -and $environment.properties.workloadProfiles[0].workloadProfileType -eq 'Consumption') 'Provision only the ACA Consumption workload profile.'
Assert-Condition ($environment.properties.vnetConfiguration.infrastructureSubnetId -match 'subnets/container-apps') 'ACA and migration jobs must reach PostgreSQL through the shared private network.'
Assert-Condition ($environment.properties.appLogsConfiguration.destination -eq 'log-analytics') 'Retain migration and application diagnostic logs.'

$definitions = @($all | Where-Object type -EQ 'Microsoft.Authorization/roleDefinitions')
Assert-Condition ($definitions.Count -eq 2) 'Only Foundry deployment manager and APIM registrar custom roles are expected.'
$allowedActions = @(
    'Microsoft.CognitiveServices/accounts/read',
    'Microsoft.CognitiveServices/accounts/deployments/read',
    'Microsoft.CognitiveServices/accounts/deployments/write',
    'Microsoft.ApiManagement/service/read',
    'Microsoft.ApiManagement/service/apis/read',
    'Microsoft.ApiManagement/service/apis/operations/read',
    'Microsoft.ApiManagement/service/apis/tools/read',
    'Microsoft.ApiManagement/service/apis/write',
    'Microsoft.ApiManagement/service/apis/policies/read',
    'Microsoft.ApiManagement/service/apis/policies/write'
)
foreach ($definition in $definitions) {
    foreach ($permission in $definition.properties.permissions) {
        Assert-Condition ($permission.dataActions.Count -eq 0) 'Custom management roles must not include data actions.'
        foreach ($action in $permission.actions) {
            Assert-Condition ($action -cin $allowedActions) "Unexpected custom role permission: $action."
        }
    }
}
Assert-Condition ($foundationText -match 'principalId: runtimeIdentity.outputs.principalId\s+principalType: ''ServicePrincipal''\s+roleDefinitionId: apiRegistrar.id') 'APIM registrar must be assigned only to runtime identity.'
$apim = Get-Resource $all 'Microsoft.ApiManagement/service'
Assert-Condition ($apim.identity.type -eq 'SystemAssigned' -and $main.parameters.apimSku.defaultValue -eq 'Developer') 'APIM must have its proof identity and explicit development SKU default.'

$insights = Get-Resource $all 'Microsoft.Insights/components'
Assert-Condition ($insights.properties.DisableLocalAuth -eq $true -and $insights.properties.CustomMetricsOptedInType -eq 'WithDimensions' -and $insights.properties.WorkspaceResourceId -match 'logAnalyticsWorkspaceId') 'Application Insights must be workspace-based, Entra-only and accept dimensioned custom metrics.'
$observabilityDeployment = @($foundationResources | Where-Object { $_.type -eq 'Microsoft.Resources/deployments' -and $_.name -eq 'gateway-observability' })
Assert-Condition ($observabilityDeployment.Count -eq 1 -and "$($observabilityDeployment[0].properties.parameters.logAnalyticsWorkspaceId.value)" -match 'logs') 'Application Insights must reuse the foundation Log Analytics workspace.'
$logger = Get-Resource $all 'Microsoft.ApiManagement/service/loggers'
Assert-Condition ($logger.properties.loggerType -eq 'applicationInsights' -and $logger.properties.credentials.identityClientId -eq 'SystemAssigned') 'APIM must log to Application Insights with its system-assigned identity, not an instrumentation key.'
$publisher = @($all | Where-Object { $_.type -eq 'Microsoft.Authorization/roleAssignments' -and "$($_.properties.roleDefinitionId)" -match 'metricsPublisherRoleId' })
Assert-Condition ($publisher.Count -eq 1 -and "$($publisher[0].properties.principalId)" -match 'identity\.principalId') 'Only the APIM identity receives Monitoring Metrics Publisher, on Application Insights.'
$diagnostics = Get-Resource $all 'Microsoft.ApiManagement/service/apis/diagnostics'
Assert-Condition ($diagnostics.properties.metrics -eq $true -and $diagnostics.properties.logClientIp -eq $false -and -not $diagnostics.properties.Contains('largeLanguageModel')) 'Inference diagnostics must enable custom token metrics without client IP or LLM message logging.'
foreach ($side in @('frontend', 'backend')) {
    foreach ($direction in @('request', 'response')) {
        Assert-Condition ($diagnostics.properties[$side][$direction].body.bytes -eq 0 -and $diagnostics.properties[$side][$direction].headers.Count -eq 0) 'Diagnostics must not log headers or bodies.'
    }
}
Assert-Condition ($main.parameters.llmTokensPerMinutePerCaller.defaultValue -eq 0) 'Optional llm-token-limit must default off; the prepaid ledger is the spend authority.'

$app = Get-Resource $gatewayResources 'Microsoft.App/containerApps'
$job = Get-Resource $jobResources 'Microsoft.App/jobs'
$jobParameterNames = @(
    'environmentName', 'location', 'jobName', 'containerAppsEnvironmentName', 'containerRegistryName',
    'migrationIdentityId', 'migrationClientId', 'imageName', 'postgresHost',
    'postgresDatabase', 'postgresAppRole', 'migrationPrincipalName', 'runtimePrincipalId'
)
Assert-Condition ($templates.'migration-job'.parameters.Count -eq $jobParameterNames.Count) 'Migration template must match the exact parent ARM hook parameter contract.'
foreach ($name in $jobParameterNames) {
    Assert-Condition ($templates.'migration-job'.parameters.Contains($name)) "Missing exact migration ARM parameter: $name."
}
Assert-Condition ($templates.gateway.parameters.imageName.metadata.description -match 'GATEWAY_DEPLOY_IMAGE.*migration hook succeeds' -and $templates.gateway.parameters.imageName.metadata.description -notmatch 'SERVICE_GATEWAY_IMAGE_NAME') 'Release image contract must name only the immutable digest gated by migration success.'
Assert-Condition (@($gatewayResources | Where-Object { $_.type -in @('Microsoft.App/jobs', 'Microsoft.Web/sites', 'Microsoft.Web/sites/slots') }).Count -eq 0) 'azd deploymentHost discovery must find only the gateway Container App in this service deployment.'
Assert-Condition ($templates.gateway.outputs.SERVICE_GATEWAY_RESOURCE_ID.value -match 'Microsoft.App/containerApps' -and $templates.gateway.outputs.SERVICE_GATEWAY_ENDPOINT_URL.value -match 'fqdn') 'Retain actual service resource ID and endpoint outputs for release verification.'
Assert-Condition ($app.tags.'azd-service-name' -eq 'gateway' -and $app.tags.Contains('azd-env-name')) 'azd must discover exactly the gateway service.'
Assert-Condition ($job.tags.Contains('azd-env-name') -and -not $job.tags.Contains('azd-service-name')) 'Migration job must identify its environment without claiming the gateway azd service.'
Assert-Condition ($app.identity.type -eq 'UserAssigned' -and ($app.identity.userAssignedIdentities.Keys -join '') -match 'runtimeIdentityId') 'Gateway must attach only runtime UAMI.'
Assert-Condition (($job.identity.userAssignedIdentities.Keys -join '') -match 'migrationIdentityId') 'Job must attach only migration UAMI.'
Assert-Condition ($app.identity.userAssignedIdentities.Count -eq 1 -and $job.identity.userAssignedIdentities.Count -eq 1) 'Identity separation must be enforced on both workloads.'
foreach ($workload in @($app, $job)) {
    Assert-Condition ($workload.properties.template.containers.Count -eq 1 -and $workload.properties.template.containers[0].image -ceq "[parameters('imageName')]") 'Every workload must use exactly the image parameter, not a fallback.'
    Assert-Condition (-not $workload.properties.configuration.Contains('secrets')) 'Passwordless workloads must not carry database credential secrets.'
}
Assert-Condition ($app.properties.environmentId -match 'containerAppsEnvironmentName' -and $job.properties.environmentId -match 'containerAppsEnvironmentName') 'Both workloads must use the same foundation environment name contract.'
Assert-Condition ($job.properties.configuration.registries[0].server -match 'containerRegistryName.*loginServer') 'Migration job must resolve the supplied foundation registry name.'
$appEnv = $templates.gateway.variables.appEnvironment
Assert-Condition ($appEnv.DATABASE_AUTH -eq 'entra' -and $appEnv.DATABASE_URL -match 'sslmode=verify-full') 'Runtime must use passwordless Entra database authentication with verified TLS.'
Assert-Condition ($appEnv.AZURE_CLIENT_ID -match 'runtimeClientId' -and -not $appEnv.Contains('MIGRATION_PRINCIPAL_NAME')) 'Runtime cannot inherit migration credentials.'
foreach ($name in @('AZURE_TENANT_ID', 'ENTRA_SPA_CLIENT_ID', 'ENTRA_API_AUDIENCE', 'ENTRA_API_SCOPE', 'GATEWAY_API_AUDIENCE', 'APIM_PRINCIPAL_ID', 'FOUNDRY_ENDPOINT', 'APIM_GATEWAY_URL')) {
    Assert-Condition ($appEnv.Contains($name)) "Required auth/endpoint variable is missing: $name."
}
Assert-Condition ($app.properties.configuration.ingress.targetPort -eq 3001 -and $app.properties.configuration.ingress.allowInsecure -eq $false) 'Ingress must use HTTPS and application port 3001.'
foreach ($replicaParameter in @('minReplicas', 'maxReplicas')) {
    Assert-Condition ($templates.gateway.parameters[$replicaParameter].type -eq 'string') 'azd native revision substitutions must not pass JSON strings to integer parameters.'
    Assert-Condition ($app.properties.template.scale[$replicaParameter] -ceq "[int(parameters('$replicaParameter'))]") 'Replica strings must be explicitly converted to integers in the ACA resource.'
}
$probes = $app.properties.template.containers[0].probes
foreach ($probeType in @('Startup', 'Liveness', 'Readiness')) {
    $probe = @($probes | Where-Object type -EQ $probeType)
    $path = if ($probeType -eq 'Readiness') { '/readyz' } else { '/healthz' }
    Assert-Condition ($probe.Count -eq 1 -and $probe[0].httpGet.path -eq $path -and $probe[0].httpGet.port -eq 3001) "$probeType must use $path on port 3001."
}

$jobEnv = $templates.'migration-job'.variables.jobEnvironment
Assert-Condition ($jobEnv.GATEWAY_MODE -eq 'azure' -and $jobEnv.DATABASE_AUTH -eq 'entra') 'Bootstrap requires Azure gateway mode with Entra database authentication.'
Assert-Condition ($job.properties.configuration.triggerType -eq 'Manual' -and $job.properties.configuration.replicaRetryLimit -eq 0) 'Migrations must never auto-run or automatically retry.'
Assert-Condition ($job.properties.configuration.manualTriggerConfig.parallelism -eq 1 -and $job.properties.configuration.manualTriggerConfig.replicaCompletionCount -eq 1) 'Migrations must use one replica.'
Assert-Condition (($job.properties.template.containers[0].command -join ' ') -ceq 'node apps/api/dist/bootstrap.js') 'Job must execute the identity-aware bootstrap/migration entry point.'
Assert-Condition ($jobEnv.AZURE_CLIENT_ID -match 'migrationClientId' -and $jobEnv.RUNTIME_PRINCIPAL_ID -match 'runtimePrincipalId') 'Bootstrap must authenticate as migration identity and map the distinct runtime object ID.'
foreach ($name in @('POSTGRES_HOST', 'POSTGRES_DATABASE', 'POSTGRES_APP_ROLE', 'MIGRATION_PRINCIPAL_NAME')) {
    Assert-Condition ($jobEnv.Contains($name)) "Bootstrap contract variable is missing: $name."
}

foreach ($file in @('inference.xml', 'readonly-tools.xml')) {
    [xml] $policy = Get-Content -LiteralPath (Join-Path $root "infra\policies\$file") -Raw
    $proof = $policy.SelectSingleNode('/policies/inbound/authentication-managed-identity')
    Assert-Condition ($proof.GetAttribute('resource') -eq '{{gateway-api-audience}}' -and $proof.GetAttribute('ignore-error') -eq 'false') 'Policies must fail closed on the dedicated APIM proof audience.'
    Assert-Condition ($null -ne $policy.SelectSingleNode('/policies/inbound/set-header[@name="X-Gateway-Authorization"][@exists-action="override"]')) 'Policies must overwrite any caller-supplied gateway proof.'
}
$authText = Get-Content -LiteralPath (Join-Path $root 'apps\api\src\auth.ts') -Raw
Assert-Condition ($authText.Contains('p.roles.includes("Gateway.Invoke")')) 'Gateway application must enforce the dedicated Gateway.Invoke proof role.'
Assert-Condition ($authText.Contains('roles.includes(AGENT_ROLE)') -and $authText.Contains('roles.filter(r => r !== AGENT_ROLE)')) 'App-only callers must require Gateway.Agent, and delegated tokens must never carry it.'
$identityText = Get-Content -LiteralPath (Join-Path $root 'scripts\azd\identity.mjs') -Raw
Assert-Condition ($identityText -match "value: 'Gateway.Agent'.*member: 'Application'") 'The user API must expose Gateway.Agent as an Application-only app role.'

Write-Output "PASS: $checks azd infrastructure checks; every Bicep entry point compiled. No Azure calls, login, tokens, Entra writes or generated files."
