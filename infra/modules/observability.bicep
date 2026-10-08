targetScope = 'resourceGroup'

@description('Application Insights component name.')
param name string

param location string = resourceGroup().location
param tags object = {}

@description('Existing Log Analytics workspace resource ID. Application Insights is workspace-based.')
param logAnalyticsWorkspaceId string

@description('Existing APIM service whose system-assigned identity publishes gateway telemetry and LLM token metrics.')
param apimServiceName string

// Built-in Monitoring Metrics Publisher: Entra-authenticated ingestion for telemetry and custom metrics.
var metricsPublisherRoleId = '3913510d-42f4-4e42-8a64-420c390055eb'

resource apim 'Microsoft.ApiManagement/service@2024-05-01' existing = {
  name: apimServiceName
}

resource insights 'Microsoft.Insights/components@2020-02-02' = {
  name: name
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalyticsWorkspaceId
    IngestionMode: 'LogAnalytics'
    // Instrumentation-key ingestion is disabled; APIM authenticates with its managed identity.
    DisableLocalAuth: true
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
    // Required for llm-emit-token-metric dimensions; not yet in the published resource type.
    #disable-next-line BCP037
    CustomMetricsOptedInType: 'WithDimensions'
  }
}

resource metricsPublisher 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(insights.id, apim.id, metricsPublisherRoleId)
  scope: insights
  properties: {
    principalId: apim.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', metricsPublisherRoleId)
  }
}

resource logger 'Microsoft.ApiManagement/service/loggers@2024-05-01' = {
  parent: apim
  name: 'gateway-appinsights'
  properties: {
    loggerType: 'applicationInsights'
    description: 'Gateway request telemetry and LLM token metrics, ingested with the APIM system-assigned identity.'
    resourceId: insights.id
    credentials: {
      connectionString: insights.properties.ConnectionString
      identityClientId: 'SystemAssigned'
    }
  }
  dependsOn: [
    metricsPublisher
  ]
}

output applicationInsightsId string = insights.id
output applicationInsightsName string = insights.name
output apimLoggerId string = logger.id