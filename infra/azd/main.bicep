targetScope = 'subscription'

@minLength(1)
@maxLength(64)
param environmentName string

@minLength(1)
param location string

@minLength(36)
@maxLength(36)
param azureTenantId string

@minLength(1)
param publisherName string

@minLength(3)
param publisherEmail string

@description('Developer is evaluation-only, without a production SLA. Confirm SKU availability and costs before provisioning.')
@allowed([
  'Developer'
  'BasicV2'
  'StandardV2'
  'PremiumV2'
])
param apimSku string = 'Developer'

@minValue(1)
@maxValue(10)
param apimCapacity int = 1

@minLength(36)
@maxLength(36)
param entraApiAudience string

@description('Distinct v2 proof API client GUID. Postprovision assigns its Gateway.Invoke app role to the APIM identity.')
@minLength(36)
@maxLength(36)
param gatewayApiAudience string

@description('Existing Foundry account resource group in this subscription. No Foundry resources are provisioned.')
@minLength(1)
param foundryResourceGroup string

@minLength(1)
param foundryAccountName string

@allowed([
  'Burstable'
  'GeneralPurpose'
  'MemoryOptimized'
])
param postgresTier string = 'Burstable'

@minLength(1)
param postgresSku string = 'Standard_B1ms'

@minValue(32)
@maxValue(16384)
param postgresStorageSizeGB int = 32

@description('Optional per-caller llm-token-limit (tokens per minute) on the APIM inference route. 0 disables it; the prepaid USD ledger always applies.')
@minValue(0)
@maxValue(100000000)
param llmTokensPerMinutePerCaller int = 0

var tags = {
  'azd-env-name': environmentName
  application: 'foundry-ai-gateway'
}
var resourceToken = uniqueString(subscription().id, environmentName, location)
var appName = 'gateway-${resourceToken}'

resource rg 'Microsoft.Resources/resourceGroups@2025-04-01' = {
  name: 'rg-${environmentName}'
  location: location
  tags: tags
}

module foundation 'modules/foundation.bicep' = {
  name: 'gateway-foundation'
  scope: rg
  params: {
    name: appName
    resourceToken: resourceToken
    location: location
    tags: tags
    azureTenantId: azureTenantId
    publisherName: publisherName
    publisherEmail: publisherEmail
    apimSku: apimSku
    apimCapacity: apimSku == 'Developer' ? 1 : apimCapacity
    entraApiAudience: entraApiAudience
    gatewayApiAudience: gatewayApiAudience
    postgresTier: postgresTier
    postgresSku: postgresSku
    postgresStorageSizeGB: postgresStorageSizeGB
    llmTokensPerMinutePerCaller: llmTokensPerMinutePerCaller
  }
}

module foundryAccess '../modules/foundry-access.bicep' = {
  name: 'gateway-foundry-access-${resourceToken}'
  scope: resourceGroup(foundryResourceGroup)
  params: {
    accountName: foundryAccountName
    appPrincipalId: foundation.outputs.runtimePrincipalId
    appIdentityResourceId: foundation.outputs.runtimeIdentityId
  }
}

output AZURE_RESOURCE_GROUP string = rg.name
output AZURE_CONTAINER_REGISTRY_NAME string = foundation.outputs.registryName
output AZURE_CONTAINER_REGISTRY_ENDPOINT string = foundation.outputs.registryEndpoint
output AZURE_CONTAINER_APPS_ENVIRONMENT_NAME string = foundation.outputs.environmentName
output AZURE_CONTAINER_APPS_ENVIRONMENT_ID string = foundation.outputs.environmentId
output AZURE_CONTAINER_APP_NAME string = appName
output SERVICE_GATEWAY_RESOURCE_ID string = resourceId(rg.name, 'Microsoft.App/containerApps', appName)
output GATEWAY_URL string = foundation.outputs.gatewayUrl
output APIM_SERVICE_NAME string = foundation.outputs.apimName
output APIM_RESOURCE_GROUP string = rg.name
output APIM_GATEWAY_URL string = foundation.outputs.apimGatewayUrl
output APIM_PRINCIPAL_ID string = foundation.outputs.apimPrincipalId
output AZURE_CLIENT_ID string = foundation.outputs.runtimeClientId
output RUNTIME_IDENTITY_ID string = foundation.outputs.runtimeIdentityId
output RUNTIME_PRINCIPAL_ID string = foundation.outputs.runtimePrincipalId
output MIGRATION_IDENTITY_ID string = foundation.outputs.migrationIdentityId
output MIGRATION_CLIENT_ID string = foundation.outputs.migrationClientId
output MIGRATION_PRINCIPAL_ID string = foundation.outputs.migrationPrincipalId
output MIGRATION_PRINCIPAL_NAME string = foundation.outputs.migrationPrincipalName
output POSTGRES_HOST string = foundation.outputs.postgresHost
output POSTGRES_DATABASE string = foundation.outputs.postgresDatabase
output POSTGRES_APP_ROLE string = 'gateway_app'
output DATABASE_URL string = foundation.outputs.databaseUrl
output DATABASE_AUTH string = 'entra'
output MIGRATION_JOB_NAME string = 'gateway-migrate-${resourceToken}'
output AZURE_LOG_ANALYTICS_WORKSPACE_ID string = foundation.outputs.logAnalyticsWorkspaceId
output APPLICATIONINSIGHTS_NAME string = foundation.outputs.applicationInsightsName
output APPLICATIONINSIGHTS_ID string = foundation.outputs.applicationInsightsId
