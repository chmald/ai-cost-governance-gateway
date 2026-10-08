#Requires -Version 7.2
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

function Assert-Condition([bool] $Condition, [string] $Message) {
    if (-not $Condition) { throw $Message }
}

foreach ($script in Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.ps1') {
    $tokens = $null
    $errors = $null
    $null = [System.Management.Automation.Language.Parser]::ParseFile($script.FullName, [ref] $tokens, [ref] $errors)
    Assert-Condition ($errors.Count -eq 0) "PowerShell syntax errors in $($script.Name): $errors"
}

$mainText = Get-Content -LiteralPath (Join-Path $root 'infra\main.bicep') -Raw
$gatewayText = Get-Content -LiteralPath (Join-Path $root 'infra\modules\gateway.bicep') -Raw
$roleText = Get-Content -LiteralPath (Join-Path $root 'infra\modules\foundry-access.bicep') -Raw
Assert-Condition ($mainText -match "secretRef: 'database-url'") 'Database connection must use an ACA secretRef.'
Assert-Condition ($mainText -match "GATEWAY_MODE: 'azure'" -and $mainText -match 'APIM_PRINCIPAL_ID: apim.identity.principalId') 'Production authentication environment is incomplete.'
Assert-Condition ($mainText -match 'Microsoft.ApiManagement/service/apis/operations/read' -and $mainText -match 'Microsoft.ApiManagement/service/apis/tools/read') 'APIM import/discovery requires operation and MCP tool reads.'
Assert-Condition ($mainText -match "type: 'Readiness'\s+httpGet: \{\s+path: '/readyz'") 'Readiness must check database/schema readiness, not only process health.'
foreach ($probe in @('Startup', 'Liveness')) {
    Assert-Condition ($mainText -match "type: '$probe'\s+httpGet: \{\s+path: '/healthz'") "$probe must check process health."
}
$dockerText = Get-Content -LiteralPath (Join-Path $root 'Dockerfile') -Raw
$dockerIgnore = Get-Content -LiteralPath (Join-Path $root '.dockerignore') -Raw
Assert-Condition ([regex]::Matches($dockerText, '(?m)^ARG NPM_CONFIG_REGISTRY=https://registry\.npmjs\.org/\r?$').Count -eq 2) 'Both npm ci stages must default to the public npm registry (override with --build-arg for a mirror).'
Assert-Condition ($dockerText -notmatch 'COPY.*\.npmrc' -and $dockerIgnore -match '(?m)^\*\*/\.npmrc\r?$') 'Do not copy credential npmrc files into the image.'
$lockText = Get-Content -LiteralPath (Join-Path $root 'package-lock.json') -Raw
$resolved = @([regex]::Matches($lockText, '"resolved":\s*"([^"]+)"') | ForEach-Object { $_.Groups[1].Value })
Assert-Condition ($resolved.Count -gt 100) 'Could not read lockfile resolved URLs.'
foreach ($url in $resolved) {
    Assert-Condition ($url -match '^https://registry\.npmjs\.org/' -or $url -match '^apps/(api|web)$') "Lockfile must resolve only from the public npm registry (mirrors rewrite it via replace-registry-host): $url"
}
Assert-Condition (-not (Test-Path -LiteralPath (Join-Path $root '.npmrc'))) 'Do not commit a project .npmrc that pins a private registry; configure mirrors per user.'
Assert-Condition ($dockerIgnore -match '(?m)^data\r?$' -and $dockerIgnore -match '(?m)^\*\*/\*\.gateway\.lock\r?$') 'Local databases and process locks must not enter the container context.'
Assert-Condition ($dockerIgnore -match '(?m)^tests\r?$' -and $dockerIgnore -match '(?m)^\*\*/tests\r?$') 'Root and workspace tests must not enter the production build context.'
$deployText = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'Deploy-Gateway.ps1') -Raw
Assert-Condition ($deployText -match 'node apps/api/dist/cli\.js migrate' -and $deployText -match 'Application-only Gateway.Invoke') 'Checklist must use the production migration CLI and exact proof application role.'
Assert-Condition ($roleText -match 'accounts@2025-06-01'' existing' -and $roleText -notmatch 'accounts/write|accounts/delete|listKeys|deployments/delete') 'Foundry scope must remain existing-account deployment read/write only.'
Assert-Condition ($gatewayText -match 'operationId: operations\[index\].id') 'MCP tools must reference full backing operation resource IDs.'
Assert-Condition ($gatewayText -notmatch 'urlTemplate: ''/\*|serviceUrl:.*foundry|subscriptionRequired: true') 'No catch-all, direct Foundry route, or undocumented subscription key.'
Assert-Condition ($gatewayText -match "path: 'openai/v1'" -and $gatewayText -match "urlTemplate: '/chat/completions'" -and $gatewayText -match "serviceUrl: '\$\{appBackendUrl\}/openai/v1'") 'Inference route must retain its full application path.'
Assert-Condition ($gatewayText -match "apis/diagnostics@" -and $gatewayText -match 'metrics: true' -and $gatewayText -match 'loggerId: apimLoggerId' -and $gatewayText -match 'logClientIp: false') 'Inference diagnostics must publish custom (token) metrics through the Application Insights logger.'
Assert-Condition ([regex]::Matches($gatewayText, 'bytes: 0').Count -eq 4 -and $gatewayText -notmatch 'largeLanguageModel') 'Gateway diagnostics must not log request or response bodies (including LLM messages).'
Assert-Condition ($gatewayText -match "replace\(loadTextContent\('../policies/inference.xml'\), '<!-- optional-llm-token-limit -->'" -and $gatewayText -match 'llmTokensPerMinutePerCaller int = 0' -and $gatewayText -match 'estimate-prompt-tokens="false"') 'Optional llm-token-limit must default off and count actual usage only.'
$observabilityText = Get-Content -LiteralPath (Join-Path $root 'infra\modules\observability.bicep') -Raw
Assert-Condition ($observabilityText -match 'WorkspaceResourceId: logAnalyticsWorkspaceId' -and $observabilityText -match 'DisableLocalAuth: true' -and $observabilityText -match "CustomMetricsOptedInType: 'WithDimensions'") 'Application Insights must be workspace-based, Entra-only and accept dimensioned custom metrics.'
Assert-Condition ($observabilityText -match "identityClientId: 'SystemAssigned'" -and $observabilityText -match '3913510d-42f4-4e42-8a64-420c390055eb' -and $observabilityText -match "loggerType: 'applicationInsights'") 'APIM must log with its managed identity and only Monitoring Metrics Publisher.'
Assert-Condition ($mainText -match "module observability 'modules/observability.bicep'" -and $mainText -match 'apimLoggerId: observability.outputs.apimLoggerId' -and $mainText -match 'Microsoft.OperationalInsights/workspaces@') 'The manual profile must wire Application Insights and the APIM logger into the gateway module.'

foreach ($file in Get-ChildItem -LiteralPath (Join-Path $root 'infra\policies') -Filter '*.xml') {
    [xml] $policy = Get-Content -LiteralPath $file.FullName -Raw
    $jwt = $policy.SelectSingleNode('/policies/inbound/validate-azure-ad-token')
    Assert-Condition ($null -ne $jwt) "$($file.Name) must validate Entra tokens."
    Assert-Condition ($jwt.GetAttribute('output-token-variable-name') -eq 'callerJwt') 'Rate limiting must use the validated JWT.'
    Assert-Condition ($jwt.SelectNodes('required-claims/claim[@name="roles"]/value').Count -ge 2) 'Missing-role tokens must be rejected.'
    $rate = $policy.SelectSingleNode('/policies/inbound/rate-limit-by-key')
    Assert-Condition ($rate.GetAttribute('counter-key').Contains('callerJwt') -and $rate.GetAttribute('counter-key').Contains('"oid"')) 'Rate key must be the trusted principal oid.'
    # Only the bounded, non-streaming inference response is buffered (for token metrics); MCP traffic is never buffered.
    $buffer = if ($file.Name -eq 'inference.xml') { 'true' } else { 'false' }
    Assert-Condition ($policy.SelectSingleNode('/policies/backend/forward-request').GetAttribute('buffer-response') -eq $buffer) "$($file.Name) must set buffer-response=$buffer."
    $text = $policy.OuterXml
    Assert-Condition ($text -notmatch 'log-to-eventhub|trace|cache-|<retry|Response.Body|set-body') 'Policies must not log content, cache or retry inference, or read response bodies.'
    Assert-Condition (@($jwt.SelectNodes('required-claims/claim[@name="roles"]/value') | Where-Object { $_.InnerText -eq 'Gateway.Agent' }).Count -eq 1) "$($file.Name) must admit the app-only Gateway.Agent application role."
    if ($file.Name -ne 'external-mcp.xml') {
        Assert-Condition ($null -ne $policy.SelectSingleNode('/policies/inbound/set-header[@name="Authorization"]')) 'Preserve the original user token.'
        Assert-Condition ($null -ne $policy.SelectSingleNode('/policies/inbound/set-header[@name="X-Gateway-Authorization"][@exists-action="override"]')) 'Application calls require a separate APIM proof token.'
    }
}
[xml] $inference = Get-Content -LiteralPath (Join-Path $root 'infra\policies\inference.xml') -Raw
Assert-Condition ($inference.SelectSingleNode('/policies/inbound/validate-content').GetAttribute('max-size') -eq '65536') 'Inference maximum body size must be 64 KiB.'
$metric = $inference.SelectSingleNode('/policies/inbound/llm-emit-token-metric')
Assert-Condition ($null -ne $metric -and $metric.GetAttribute('namespace') -eq 'ai-gateway') 'Inference must emit LLM token metrics to Application Insights.'
$dimensions = @($metric.SelectNodes('dimension') | ForEach-Object { $_.GetAttribute('name') })
Assert-Condition ($dimensions.Count -le 5) 'llm-emit-token-metric supports at most five custom dimensions.'
foreach ($name in @('API ID', 'Team ID', 'Model', 'Client App ID', 'Caller Type')) {
    Assert-Condition ($dimensions -contains $name) "Token metrics need the $name chargeback dimension."
}
$inbound = @($inference.SelectSingleNode('/policies/inbound').ChildNodes | Where-Object NodeType -EQ 'Element' | ForEach-Object Name)
Assert-Condition ($inbound.IndexOf('llm-emit-token-metric') -gt $inbound.IndexOf('validate-content') -and $inbound.IndexOf('llm-emit-token-metric') -lt $inbound.IndexOf('authentication-managed-identity')) 'Token metrics must follow request validation and precede the APIM proof.'
foreach ($variable in @('metricTeam', 'metricModel', 'metricClientApp')) {
    Assert-Condition ($inference.SelectSingleNode("/policies/inbound/set-variable[@name='$variable']").GetAttribute('value') -match 'Regex\.IsMatch') "Metric dimension $variable must be a bounded identifier."
}
Assert-Condition ($inference.OuterXml.Contains('<!-- optional-llm-token-limit -->')) 'Inference policy must keep the optional llm-token-limit insertion point.'

& (Join-Path $PSScriptRoot 'Deploy-Gateway.ps1') -Action Build
Assert-Condition ($?) 'Local Bicep build failed.'

$rejected = $false
try {
    & (Join-Path $PSScriptRoot 'Deploy-Gateway.ps1') -Action Validate `
        -SubscriptionId '11111111-1111-4111-8111-111111111111' -ResourceGroup 'offline-test-only' `
        -ParameterFile (Join-Path $root 'infra\main.parameters.example.json') -PrerequisitesReviewed -DryRun
}
catch {
    $rejected = $_.Exception.Message -match 'Unresolved placeholder'
}
Assert-Condition $rejected 'Deployment helper must refuse unresolved example placeholders.'

# Nonexistent test-only identities are passed exclusively through local dry-run.
$fixture = Get-Content -LiteralPath (Join-Path $root 'infra\main.parameters.example.json') -Raw | ConvertFrom-Json -AsHashtable
$values = @{
    location = 'eastus2'
    appName = 'gateway-offline-test'
    apimServiceName = 'gateway-offline-test-apim'
    publisherName = 'Offline test'
    publisherEmail = 'operator@example.org'
    containerRegistryName = 'gatewayofflinetest'
    imageRepositoryDigest = ('gateway@sha256:' + ('a' * 64))
    azureTenantId = '11111111-1111-4111-8111-111111111111'
    entraSpaClientId = '22222222-2222-4222-8222-222222222222'
    entraApiAudience = '33333333-3333-4333-8333-333333333333'
    entraApiScope = 'api://33333333-3333-4333-8333-333333333333/access_as_user'
    gatewayApiAudience = '44444444-4444-4444-8444-444444444444'
    foundryResourceGroup = 'gateway-offline-foundry'
    foundryAccountName = 'gateway-offline-foundry'
    foundryEndpoint = 'https://gateway-offline-foundry.openai.azure.com'
}
foreach ($name in $values.Keys) { $fixture.parameters[$name].value = $values[$name] }
$fixture.parameters.databaseUrl.reference.keyVault.id = '/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/offline-test/providers/Microsoft.KeyVault/vaults/offline-test'
$fixture.parameters.databaseUrl.reference.secretName = 'offline-test-not-a-secret'
$fixturePath = Join-Path $PSScriptRoot ('.infra-validation-' + [guid]::NewGuid().ToString('N') + '.local.json')
$helper = Join-Path $PSScriptRoot 'Deploy-Gateway.ps1'
$dryRun = @{
    Action = 'Validate'
    SubscriptionId = '11111111-1111-4111-8111-111111111111'
    ResourceGroup = 'offline-test-only'
    ParameterFile = $fixturePath
    PrerequisitesReviewed = $true
    DryRun = $true
}
try {
    $fixture | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $fixturePath -NoNewline
    $result = & $helper @dryRun
    Assert-Condition (($result -join "`n") -match 'No Azure calls or secret resolution occurred') 'A valid local dry-run must not contact Azure.'

    $fixture.parameters.mcpAllowedHosts.value = @('*.example.org')
    $fixture | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $fixturePath -NoNewline
    $rejected = $false
    try { $null = & $helper @dryRun }
    catch { $rejected = $_.Exception.Message -match 'without wildcards' }
    Assert-Condition $rejected 'Wildcard MCP hosts must be refused.'

    $fixture.parameters.mcpAllowedHosts.value = @()
    $fixture.parameters.databaseUrl = @{ value = 'non-secret-test-literal' }
    $fixture | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $fixturePath -NoNewline
    $rejected = $false
    try { $null = & $helper @dryRun }
    catch { $rejected = $_.Exception.Message -match 'not a secret literal' }
    Assert-Condition $rejected 'Literal database secret parameters must be refused.'
}
finally {
    if (Test-Path -LiteralPath $fixturePath) { Remove-Item -LiteralPath $fixturePath }
}
Write-Output 'PASS: Bicep, XML, PowerShell, route/auth/RBAC invariants, placeholder/secret/wildcard refusal and valid local dry-run. No Azure calls.'
