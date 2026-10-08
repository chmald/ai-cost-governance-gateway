#Requires -Version 7.2
<#
.SYNOPSIS
Offline-first checklist and explicitly invoked Azure deployment helper.
.DESCRIPTION
Defaults to Checklist. Build only compiles Bicep locally. Validate and WhatIf
contact Azure without deploying. Deploy requires -ApproveDeployment and
-PrerequisitesReviewed. -DryRun never contacts Azure. PowerShell -WhatIf also
prevents an Azure invocation. No login, subscription selection, provider
registration, package installation, image build, or database migration is automatic.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [ValidateSet('Checklist', 'Build', 'Validate', 'WhatIf', 'Deploy')]
    [string] $Action = 'Checklist',
    [string] $SubscriptionId,
    [string] $ResourceGroup,
    [string] $ParameterFile,
    [ValidatePattern('^[A-Za-z0-9._()-]{1,64}$')]
    [string] $DeploymentName = 'ai-gateway',
    [switch] $PrerequisitesReviewed,
    [switch] $ApproveDeployment,
    [switch] $DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$templateFile = Join-Path $root 'infra\main.bicep'

function Show-Checklist {
    @'
AI GATEWAY — NO AZURE CHANGES HAVE BEEN MADE

Prerequisites to resolve before Azure validation/deployment:
  [ ] Real, enabled subscription and explicit existing target resource group.
      Tenant-only Azure CLI login is insufficient. No subscription is assumed.
      Sign in to the intended tenant and select the subscription explicitly:
        az login --tenant <tenant-guid>
        az account set --subscription <subscription-guid>
        az account show --query "{tenant:tenantId, subscription:id}" -o table
  [ ] Existing Azure OpenAI-compatible Foundry account and approved quota in
      this subscription; a different Foundry resource group is supported.
  [ ] Externally operated production PostgreSQL with backups, tested migrations,
      certificate-verified TLS and limited connectivity. No DB is provisioned.
      Never enable "all Azure services" or a 0.0.0.0/0 database firewall rule.
  [ ] DATABASE_URL stored in an existing Key Vault secret; ARM deployment secret
      reference permissions enabled. No secret literal in parameter files/CLI.
  [ ] Operator-created Entra SPA, user API and separate internal proof API.
      User API exposes access_as_user and Gateway.Reader/User/Admin app roles.
      Register actual portal redirect URIs and grant required consent.
      Proof API uses v2 tokens and exposes an Application-only Gateway.Invoke
      app role; assign it to APIM's system identity after APIM exists.
      Optional: an Application-only Gateway.Agent role on the user API for
      app-only callers (agents/managed identities), assigned per caller and
      registered on a team as an application identity.
  [ ] Exact external MCP host/audience allowlists (empty disables registration).
      Approve backend-specific APIM application permissions before use.
  [ ] Existing RBAC-mode ACR in target RG, containing a tested image digest.
      Optional infra\registry.bicep is a separately approved bootstrap.
  [ ] Deployment identity can deploy resources and create custom roles/role
      assignments in the app and Foundry resource groups.
  [ ] Providers Microsoft.App, Microsoft.ApiManagement, Microsoft.ManagedIdentity,
      Microsoft.ContainerRegistry, Microsoft.CognitiveServices, Microsoft.Insights
      and Microsoft.OperationalInsights are registered.
  [ ] Network-isolation decision reviewed. This baseline publishes the portal
      over HTTPS and relies on JWT + APIM oid proof for the data plane.
      It does NOT privatize existing Foundry/PostgreSQL or cap the Azure invoice.
      For invoice isolation, separately configure private endpoints, private DNS,
      routed ACA subnet and APIM connectivity; disable Foundry public/key access
      and remove bypass principals. Do not weaken a private database firewall.
  [ ] No APIM request/response body/header logging, MCP response buffering, retries,
      semantic caching, direct Foundry routes, or wildcard management proxy.
      Token metrics (llm-emit-token-metric) go to the provisioned Application
      Insights via APIM's managed identity, with custom metric dimensions enabled
      by the template. Verify the metrics arrive after deployment.
  [ ] Integration tests prove direct app inference/tools reject missing/forged
      gateway proof, wrong oid/audience, missing roles and unauthorized teams.
      Test native MCP discovery/calls plus external MCP streaming after deploy.

Staged image commands for an operator to review and invoke separately:
  npm ci
  npm run build
  npm test
  docker build --pull -t <registry>.azurecr.io/gateway:<release> .
  az acr login --name <registry> --subscription <subscription-guid>
  docker push <registry>.azurecr.io/gateway:<release>
  az acr repository show --name <registry> --image gateway:<release> `
      --subscription <subscription-guid> --query digest -o tsv
  Set imageRepositoryDigest to gateway@sha256:<reported-digest>.
  Explicit production migration, executed once inside the built image at /app:
    node apps/api/dist/cli.js migrate
  Supply the same production configuration/identity as the app, including
  GATEWAY_MODE=azure, NODE_ENV=production and secret-injected DATABASE_URL.
  Do not use a development tsx-based npm migration script in this image.
  Startup never migrates production automatically; /readyz checks DB and schema.

Commands (run from the project root):
  .\scripts\Deploy-Gateway.ps1 -Action Build
  Copy-Item .\infra\main.parameters.example.json .\infra\main.parameters.local.json
  # Replace every placeholder; use a Key Vault reference, never a secret literal.
  .\scripts\Deploy-Gateway.ps1 -Action Validate -SubscriptionId <guid> `
      -ResourceGroup <rg> -ParameterFile .\infra\main.parameters.local.json `
      -PrerequisitesReviewed
  # Replace Validate with WhatIf for Azure's deployment preview.
  # Deploy additionally requires -ApproveDeployment after reviewing the preview.
  # -DryRun performs only local validation; -WhatIf prevents cloud invocation.

After deployment: grant proof API Gateway.Invoke to the APIM principal ID output;
verify role propagation, /healthz, /readyz, JWT authorization, MCP transport, ledger
reservation/reconciliation, current model prices/limits, and external egress.
The service must stay fail-closed until these acceptance checks pass.
'@ | Write-Output
}

function Get-CompiledTemplate([string] $Path) {
    if (-not (Get-Command bicep -ErrorAction SilentlyContinue)) {
        throw 'Bicep CLI is required. Install it separately; this helper never installs tools.'
    }
    $compiled = & bicep build $Path --stdout
    if ($LASTEXITCODE -ne 0) { throw "Bicep compilation failed: $Path" }
    return (($compiled -join "`n") | ConvertFrom-Json -AsHashtable)
}

function Assert-Guid([string] $Value, [string] $Label) {
    $parsed = [guid]::Empty
    if (-not [guid]::TryParse($Value, [ref] $parsed) -or $parsed -eq [guid]::Empty) {
        throw "$Label must be an explicit nonzero GUID."
    }
}

function Get-DeploymentParameters([hashtable] $Template) {
    if ([string]::IsNullOrWhiteSpace($ParameterFile) -or -not (Test-Path -LiteralPath $ParameterFile -PathType Leaf)) {
        throw 'An existing deployment parameter JSON file is required.'
    }
    $data = Get-Content -LiteralPath $ParameterFile -Raw | ConvertFrom-Json -AsHashtable
    if (-not $data.ContainsKey('parameters')) { throw 'Missing parameters object.' }
    $parameters = $data.parameters
    foreach ($name in $Template.parameters.Keys) {
        if (-not $Template.parameters[$name].ContainsKey('defaultValue') -and -not $parameters.ContainsKey($name)) {
            throw "Required parameter is missing: $name"
        }
    }
    foreach ($name in $parameters.Keys) {
        if (-not $Template.parameters.ContainsKey($name)) { throw "Unknown parameter: $name" }
        $entry = $parameters[$name]
        $serialized = $entry | ConvertTo-Json -Depth 30 -Compress
        if ($serialized -match '(?i)REPLACE_|CHANGEME|<[^>]+>|00000000-0000-0000-0000-000000000000') {
            throw "Unresolved placeholder in parameter: $name"
        }
        if ($entry.ContainsKey('value') -and $entry.value -is [string] -and
            [string]::IsNullOrWhiteSpace($entry.value) -and $name -ne 'infrastructureSubnetId') {
            throw "Empty parameter: $name"
        }
    }
    $secret = $parameters.databaseUrl
    if ($secret.ContainsKey('value') -or -not $secret.ContainsKey('reference')) {
        throw 'databaseUrl must use an ARM Key Vault reference, not a secret literal.'
    }
    $reference = $secret.reference
    if (-not $reference.ContainsKey('keyVault') -or
        -not $reference.keyVault.ContainsKey('id') -or
        -not $reference.ContainsKey('secretName') -or
        $reference.keyVault.id -notmatch '^/subscriptions/[0-9a-f-]{36}/resourceGroups/[^/]+/providers/Microsoft.KeyVault/vaults/[^/]+$' -or
        $reference.secretName -notmatch '^[A-Za-z0-9-]+$') {
        throw 'databaseUrl must reference an existing Key Vault and secret name.'
    }
    Assert-Guid $parameters.azureTenantId.value 'azureTenantId'
    Assert-Guid $parameters.entraSpaClientId.value 'entraSpaClientId'
    Assert-Guid $parameters.entraApiAudience.value 'entraApiAudience (v2 token application GUID)'
    Assert-Guid $parameters.gatewayApiAudience.value 'gatewayApiAudience (v2 token application GUID)'
    if ($parameters.entraApiAudience.value -eq $parameters.gatewayApiAudience.value) {
        throw 'User and internal gateway token audiences must be separate.'
    }
    if ($parameters.imageRepositoryDigest.value -notmatch '^[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$') {
        throw 'imageRepositoryDigest must be a repository pinned to a SHA-256 digest, not a mutable tag.'
    }
    if ($parameters.containerRegistryName.value -notmatch '^[a-zA-Z0-9]{5,50}$') {
        throw 'containerRegistryName must name an existing ACR in the target resource group.'
    }
    if ($parameters.foundryEndpoint.value -notmatch '^https://[a-zA-Z0-9-]+\.(openai\.azure\.com|services\.ai\.azure\.com)/?$') {
        throw 'foundryEndpoint must be the HTTPS origin of the approved Azure public-cloud Foundry account.'
    }
    foreach ($name in @('mcpAllowedHosts', 'mcpAllowedAudiences')) {
        if (-not $parameters.ContainsKey($name)) { continue }
        if ($parameters[$name].value -isnot [array]) { throw "$name must be an array." }
        foreach ($entry in $parameters[$name].value) {
            if ([string]::IsNullOrWhiteSpace($entry) -or $entry -match '[*,\s]') {
                throw "$name must contain exact nonempty values without wildcards."
            }
            if ($name -eq 'mcpAllowedHosts' -and
                ($entry -notmatch '^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$' -or
                 $entry -match '(?i)(^|\.)localhost$|\.local$|\.internal$')) {
                throw 'MCP hosts must be public DNS names, not URLs, ports or private addresses.'
            }
            if ($name -eq 'mcpAllowedAudiences' -and $entry -eq $parameters.gatewayApiAudience.value) {
                throw 'External MCP must not share the internal gateway proof audience.'
            }
        }
    }
    if ($parameters.ContainsKey('minReplicas') -and $parameters.ContainsKey('maxReplicas') -and
        $parameters.minReplicas.value -gt $parameters.maxReplicas.value) {
        throw 'minReplicas must not exceed maxReplicas.'
    }
    return $parameters
}

function Invoke-AzJson([string[]] $Arguments) {
    $result = & az @Arguments --only-show-errors --output json
    if ($LASTEXITCODE -ne 0) { throw 'Azure validation failed. Check the explicit target, access and prerequisites.' }
    return (($result -join "`n") | ConvertFrom-Json -AsHashtable)
}

if ($Action -eq 'Checklist') {
    Show-Checklist
    return
}

$template = Get-CompiledTemplate $templateFile
if ($Action -eq 'Build') {
    $null = Get-CompiledTemplate (Join-Path $root 'infra\registry.bicep')
    Write-Output 'Bicep compiled successfully. No generated files, Azure calls, or deployments.'
    return
}

Assert-Guid $SubscriptionId 'SubscriptionId'
if ([string]::IsNullOrWhiteSpace($ResourceGroup) -or $ResourceGroup -match '[/\\<>]' -or $ResourceGroup.StartsWith('-')) {
    throw 'An explicit existing resource group name is required.'
}
$parameters = Get-DeploymentParameters $template
if (-not $PrerequisitesReviewed) { throw 'Review Checklist and docs\03b-manual-deployment.md, then supply -PrerequisitesReviewed.' }
if ($Action -eq 'Deploy' -and -not $ApproveDeployment) {
    throw 'Deployment is disabled without the explicit -ApproveDeployment switch.'
}

$verb = @{ Validate = 'validate'; WhatIf = 'what-if'; Deploy = 'create' }[$Action]
$target = "subscription=$SubscriptionId; resourceGroup=$ResourceGroup; deployment=$DeploymentName"
if ($DryRun) {
    Write-Output "Local parameters and Bicep valid. Would run Azure group deployment $verb against $target."
    Write-Output 'No Azure calls or secret resolution occurred.'
    return
}
if (-not $PSCmdlet.ShouldProcess($target, "Azure group deployment $verb (with prerequisite reads)")) { return }
if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    throw 'Azure CLI is required. Install it and sign in with az login --tenant <tenant-guid>; this helper never installs tools or selects a subscription.'
}

$subscription = Invoke-AzJson @('account', 'show', '--subscription', $SubscriptionId)
if ($subscription.id -ne $SubscriptionId -or $subscription.state -ne 'Enabled' -or
    $subscription.tenantId -ne $parameters.azureTenantId.value) {
    throw 'Azure subscription state or tenant does not match the explicit deployment target.'
}
$null = Invoke-AzJson @('group', 'show', '--subscription', $SubscriptionId, '--name', $ResourceGroup)
$foundryId = "/subscriptions/$SubscriptionId/resourceGroups/$($parameters.foundryResourceGroup.value)/providers/Microsoft.CognitiveServices/accounts/$($parameters.foundryAccountName.value)"
$foundry = Invoke-AzJson @('resource', 'show', '--subscription', $SubscriptionId, '--ids', $foundryId, '--api-version', '2025-06-01', '--query', '{id:id,kind:kind,state:properties.provisioningState}')
if ($foundry.kind -notin @('OpenAI', 'AIServices') -or $foundry.state -ne 'Succeeded') {
    throw 'The existing Foundry prerequisite is not an available OpenAI/AI Services account.'
}
$null = Invoke-AzJson @('acr', 'show', '--subscription', $SubscriptionId, '--resource-group', $ResourceGroup, '--name', $parameters.containerRegistryName.value, '--query', '{id:id}')
$resolvedParameters = (Resolve-Path -LiteralPath $ParameterFile).Path
$arguments = @(
    'deployment', 'group', $verb,
    '--subscription', $SubscriptionId,
    '--resource-group', $ResourceGroup,
    '--name', $DeploymentName,
    '--template-file', $templateFile,
    '--parameters', "@$resolvedParameters",
    '--only-show-errors'
)
if ($Action -eq 'Deploy') { $arguments += @('--query', 'properties.outputs', '--output', 'json') }
& az @arguments
if ($LASTEXITCODE -ne 0) { throw "Azure deployment $verb failed. No success is assumed." }
if ($Action -eq 'Deploy') {
    Write-Output 'Infrastructure deployed. Complete Entra APIM app-role assignment, DB migrations and acceptance checks before allowing users.'
}
