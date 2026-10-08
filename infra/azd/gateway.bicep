targetScope = 'resourceGroup'

@minLength(1)
param environmentName string
param location string = resourceGroup().location
@minLength(2)
@maxLength(32)
param appName string
param containerAppsEnvironmentName string
param containerRegistryName string
param runtimeIdentityId string
param runtimeClientId string

@description('Immutable GATEWAY_DEPLOY_IMAGE digest released only after the service predeploy migration hook succeeds. No default or placeholder.')
@minLength(1)
param imageName string

param azureTenantId string
param entraSpaClientId string
param entraApiAudience string
param entraApiScope string
param gatewayApiAudience string
param apimPrincipalId string
param apimServiceName string
param apimResourceGroup string
param apimGatewayUrl string
param foundryResourceGroup string
param foundryAccountName string
param foundryEndpoint string
param postgresHost string
@allowed([
  'gateway'
])
param postgresDatabase string = 'gateway'
@allowed([
  'gateway_app'
])
param postgresAppRole string = 'gateway_app'

@description('Comma-separated, exact approved hosts. Empty disables external MCP registration; hooks validate no wildcards.')
param mcpAllowedHosts string = ''
@description('Comma-separated, exact approved token audiences. Empty disables external MCP registration.')
param mcpAllowedAudiences string = ''
// azd's revision helper substitutes JSON strings without provisioning-time type coercion.
@allowed([
  '1'
  '2'
  '3'
  '4'
  '5'
  '6'
  '7'
  '8'
  '9'
  '10'
])
param minReplicas string = '1'
@allowed([
  '1'
  '2'
  '3'
  '4'
  '5'
  '6'
  '7'
  '8'
  '9'
  '10'
  '11'
  '12'
  '13'
  '14'
  '15'
  '16'
  '17'
  '18'
  '19'
  '20'
  '21'
  '22'
  '23'
  '24'
  '25'
  '26'
  '27'
  '28'
  '29'
  '30'
])
param maxReplicas string = '3'

resource environment 'Microsoft.App/managedEnvironments@2025-01-01' existing = {
  name: containerAppsEnvironmentName
}
resource registry 'Microsoft.ContainerRegistry/registries@2025-04-01' existing = {
  name: containerRegistryName
}

var appEnvironment = {
  GATEWAY_MODE: 'azure'
  NODE_ENV: 'production'
  HOST: '0.0.0.0'
  PORT: '3001'
  AZURE_CLIENT_ID: runtimeClientId
  AZURE_TENANT_ID: azureTenantId
  AZURE_SUBSCRIPTION_ID: subscription().subscriptionId
  ENTRA_SPA_CLIENT_ID: entraSpaClientId
  ENTRA_API_AUDIENCE: entraApiAudience
  ENTRA_API_SCOPE: entraApiScope
  GATEWAY_API_AUDIENCE: gatewayApiAudience
  APIM_PRINCIPAL_ID: apimPrincipalId
  APIM_RESOURCE_GROUP: apimResourceGroup
  APIM_SERVICE_NAME: apimServiceName
  APIM_GATEWAY_URL: apimGatewayUrl
  FOUNDRY_RESOURCE_GROUP: foundryResourceGroup
  FOUNDRY_ACCOUNT_NAME: foundryAccountName
  FOUNDRY_ENDPOINT: foundryEndpoint
  MCP_ALLOWED_HOSTS: mcpAllowedHosts
  MCP_ALLOWED_AUDIENCES: mcpAllowedAudiences
  DATABASE_AUTH: 'entra'
  DATABASE_URL: 'postgresql://${postgresAppRole}@${postgresHost}:5432/${postgresDatabase}?sslmode=verify-full'
}

resource app 'Microsoft.App/containerApps@2025-01-01' = {
  name: appName
  location: location
  tags: {
    'azd-env-name': environmentName
    'azd-service-name': 'gateway'
    application: 'foundry-ai-gateway'
  }
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${runtimeIdentityId}': {}
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
          identity: runtimeIdentityId
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'gateway'
          image: imageName
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: map(items(appEnvironment), item => {
            name: item.key
            value: item.value
          })
          probes: [
            {
              type: 'Startup'
              httpGet: {
                path: '/healthz'
                port: 3001
              }
              periodSeconds: 5
              failureThreshold: 30
              timeoutSeconds: 3
            }
            {
              type: 'Liveness'
              httpGet: {
                path: '/healthz'
                port: 3001
              }
              periodSeconds: 30
              failureThreshold: 3
              timeoutSeconds: 3
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/readyz'
                port: 3001
              }
              periodSeconds: 10
              failureThreshold: 3
              timeoutSeconds: 5
            }
          ]
        }
      ]
      scale: {
        minReplicas: int(minReplicas)
        maxReplicas: int(maxReplicas)
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
}

output SERVICE_GATEWAY_RESOURCE_ID string = app.id
output SERVICE_GATEWAY_ENDPOINT_URL string = 'https://${app.properties.configuration.ingress.fqdn}'
