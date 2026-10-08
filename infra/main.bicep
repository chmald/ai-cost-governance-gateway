targetScope = 'resourceGroup'

param location string = resourceGroup().location
param tags object = {
  application: 'foundry-ai-gateway'
}

@minLength(2)
@maxLength(32)
param appName string

@minLength(2)
@maxLength(50)
param apimServiceName string

param publisherName string
param publisherEmail string

@description('Developer is for evaluation only. StandardV2 is the default production starting point; assess capacity and networking before deployment.')
@allowed([
  'Developer'
  'BasicV2'
  'StandardV2'
  'PremiumV2'
])
param apimSku string = 'StandardV2'

@minValue(1)
param apimCapacity int = 1

@description('Existing ACR in this resource group, using registry-level RBAC (not repository ABAC). Bootstrap separately with registry.bicep if needed.')
param containerRegistryName string

@description('Previously built image repository and immutable digest, for example gateway@sha256:<64 hexadecimal characters>.')
param imageRepositoryDigest string

@secure()
@description('Externally operated PostgreSQL connection string. Supply through an ARM Key Vault parameter reference; require certificate-verified TLS.')
param databaseUrl string

param azureTenantId string
param entraSpaClientId string
@description('User API application/client GUID: v2 access-token aud is a GUID, not the api:// scope URI.')
param entraApiAudience string
param entraApiScope string

@description('Application/client GUID of the operator-registered v2 internal proof API. Used both as APIM MI token resource and expected aud; must differ from the user API GUID.')
param gatewayApiAudience string

@description('Existing Foundry account resource group in the deployment subscription; may differ from this resource group.')
param foundryResourceGroup string
param foundryAccountName string
param foundryEndpoint string

@description('Exact operator-approved external MCP DNS hosts. Empty disables new external registrations; wildcards are forbidden.')
param mcpAllowedHosts array = []

@description('Exact token resources approved for APIM identity access to external MCP backends. Empty disables new external registrations.')
param mcpAllowedAudiences array = []

@description('Optional, precreated and correctly delegated Container Apps infrastructure subnet. This does not configure Foundry or PostgreSQL private endpoints/DNS.')
param infrastructureSubnetId string = ''

@minValue(1)
@maxValue(10)
param minReplicas int = 1

@minValue(1)
@maxValue(30)
param maxReplicas int = 5

@description('Optional per-caller llm-token-limit (tokens per minute) on the inference route. 0 disables it; the prepaid USD ledger always applies.')
@minValue(0)
@maxValue(100000000)
param llmTokensPerMinutePerCaller int = 0

@minValue(30)
@maxValue(730)
param logRetentionInDays int = 30

resource appIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${appName}-identity'
  location: location
  tags: tags
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: containerRegistryName
}

resource imagePull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, appIdentity.id, 'AcrPull')
  scope: registry
  properties: {
    principalId: appIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
  }
}

resource apim 'Microsoft.ApiManagement/service@2024-05-01' = {
  name: apimServiceName
  location: location
  tags: tags
  sku: {
    name: apimSku
    capacity: apimCapacity
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    publisherEmail: publisherEmail
    publisherName: publisherName
    publicNetworkAccess: 'Enabled'
    virtualNetworkType: 'None'
  }
}

resource apimApiManager 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(resourceGroup().id, apim.name, 'gateway-mcp-api-manager-v1')
  properties: {
    roleName: '${apim.name} MCP API registrar'
    description: 'Read APIM APIs, operations and tools; create/update API definitions and their policies. No service, user, subscription-key or role management.'
    type: 'CustomRole'
    assignableScopes: [
      resourceGroup().id
    ]
    permissions: [
      {
        actions: [
          'Microsoft.ApiManagement/service/read'
          'Microsoft.ApiManagement/service/apis/read'
          'Microsoft.ApiManagement/service/apis/operations/read'
          'Microsoft.ApiManagement/service/apis/tools/read'
          'Microsoft.ApiManagement/service/apis/write'
          'Microsoft.ApiManagement/service/apis/policies/read'
          'Microsoft.ApiManagement/service/apis/policies/write'
        ]
        notActions: []
        dataActions: []
        notDataActions: []
      }
    ]
  }
}

resource apimApiManagerAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(apim.id, appIdentity.id, apimApiManager.id)
  scope: apim
  properties: {
    principalId: appIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: apimApiManager.id
  }
}

module foundryAccess 'modules/foundry-access.bicep' = {
  name: '${appName}-foundry-access'
  scope: resourceGroup(foundryResourceGroup)
  params: {
    accountName: foundryAccountName
    appPrincipalId: appIdentity.properties.principalId
    appIdentityResourceId: appIdentity.id
  }
}

// Gateway telemetry only (APIM requests and LLM token metrics); application container logs stay disabled.
resource logs 'Microsoft.OperationalInsights/workspaces@2025-02-01' = {
  name: '${appName}-logs'
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: logRetentionInDays
    features: {
      enableLogAccessUsingOnlyResourcePermissions: true
    }
  }
}

module observability 'modules/observability.bicep' = {
  name: '${appName}-observability'
  params: {
    name: '${appName}-insights'
    location: location
    tags: tags
    logAnalyticsWorkspaceId: logs.id
    apimServiceName: apim.name
  }
}

resource environment 'Microsoft.App/managedEnvironments@2025-01-01' = {
  name: '${appName}-environment'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'none'
    }
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
    vnetConfiguration: empty(infrastructureSubnetId) ? null : {
      infrastructureSubnetId: infrastructureSubnetId
      internal: false
    }
  }
}

var appEnvironment = {
  GATEWAY_MODE: 'azure'
  NODE_ENV: 'production'
  HOST: '0.0.0.0'
  PORT: '3001'
  AZURE_CLIENT_ID: appIdentity.properties.clientId
  AZURE_TENANT_ID: azureTenantId
  ENTRA_SPA_CLIENT_ID: entraSpaClientId
  ENTRA_API_AUDIENCE: entraApiAudience
  ENTRA_API_SCOPE: entraApiScope
  GATEWAY_API_AUDIENCE: gatewayApiAudience
  APIM_PRINCIPAL_ID: apim.identity.principalId
  AZURE_SUBSCRIPTION_ID: subscription().subscriptionId
  FOUNDRY_RESOURCE_GROUP: foundryResourceGroup
  FOUNDRY_ACCOUNT_NAME: foundryAccountName
  FOUNDRY_ENDPOINT: foundryEndpoint
  APIM_RESOURCE_GROUP: resourceGroup().name
  APIM_SERVICE_NAME: apim.name
  APIM_GATEWAY_URL: apim.properties.gatewayUrl
  MCP_ALLOWED_HOSTS: join(mcpAllowedHosts, ',')
  MCP_ALLOWED_AUDIENCES: join(mcpAllowedAudiences, ',')
}

resource app 'Microsoft.App/containerApps@2025-01-01' = {
  name: appName
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${appIdentity.id}': {}
    }
  }
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        allowInsecure: false
        targetPort: 3001
        transport: 'http'
      }
      registries: [
        {
          server: registry.properties.loginServer
          identity: appIdentity.id
        }
      ]
      secrets: [
        {
          name: 'database-url'
          value: databaseUrl
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'gateway'
          image: '${registry.properties.loginServer}/${imageRepositoryDigest}'
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: concat(map(items(appEnvironment), item => {
            name: item.key
            value: item.value
          }), [
            {
              name: 'DATABASE_URL'
              secretRef: 'database-url'
            }
          ])
          probes: [
            {
              type: 'Startup'
              httpGet: {
                path: '/healthz'
                port: 3001
                scheme: 'HTTP'
              }
              initialDelaySeconds: 5
              periodSeconds: 10
              failureThreshold: 10
              timeoutSeconds: 5
            }
            {
              type: 'Liveness'
              httpGet: {
                path: '/healthz'
                port: 3001
                scheme: 'HTTP'
              }
              periodSeconds: 30
              timeoutSeconds: 5
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/readyz'
                port: 3001
                scheme: 'HTTP'
              }
              periodSeconds: 10
              timeoutSeconds: 5
            }
          ]
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
        rules: [
          {
            name: 'http'
            http: {
              metadata: {
                concurrentRequests: '20'
              }
            }
          }
        ]
      }
    }
  }
  dependsOn: [
    imagePull
    foundryAccess
    apimApiManagerAssignment
  ]
}

// Separate phase: APIM exists before the app needs its oid; its APIs need the app's FQDN.
module gateway 'modules/gateway.bicep' = {
  name: '${appName}-gateway-apis'
  params: {
    apimServiceName: apim.name
    appBackendUrl: 'https://${app.properties.configuration.ingress.fqdn}'
    azureTenantId: azureTenantId
    entraApiAudience: entraApiAudience
    gatewayApiAudience: gatewayApiAudience
    apimLoggerId: observability.outputs.apimLoggerId
    llmTokensPerMinutePerCaller: llmTokensPerMinutePerCaller
  }
}

output applicationUrl string = 'https://${app.properties.configuration.ingress.fqdn}'
output gatewayUrl string = apim.properties.gatewayUrl
output chatCompletionsUrl string = '${apim.properties.gatewayUrl}/openai/v1/chat/completions'
output readOnlyMcpUrl string = '${apim.properties.gatewayUrl}/mcp/governance/mcp'
output appManagedIdentityPrincipalId string = appIdentity.properties.principalId
output appManagedIdentityClientId string = appIdentity.properties.clientId
output apimManagedIdentityPrincipalId string = apim.identity.principalId
output applicationInsightsName string = observability.outputs.applicationInsightsName
output logAnalyticsWorkspaceId string = logs.id
