targetScope = 'resourceGroup'

param environmentName string
param location string = resourceGroup().location
@minLength(2)
@maxLength(32)
param jobName string
param containerAppsEnvironmentName string
param containerRegistryName string
param migrationIdentityId string
param migrationClientId string
param migrationPrincipalName string
param runtimePrincipalId string
param postgresHost string
@allowed([
  'gateway'
])
param postgresDatabase string = 'gateway'
@allowed([
  'gateway_app'
])
param postgresAppRole string = 'gateway_app'

@description('Immutable GATEWAY_DEPLOY_IMAGE digest resolved from SERVICE_GATEWAY_IMAGE_NAME by service predeploy. Must match the application release.')
@minLength(1)
param imageName string

resource environment 'Microsoft.App/managedEnvironments@2025-01-01' existing = {
  name: containerAppsEnvironmentName
}
resource registry 'Microsoft.ContainerRegistry/registries@2025-04-01' existing = {
  name: containerRegistryName
}

var jobEnvironment = {
  GATEWAY_MODE: 'azure'
  NODE_ENV: 'production'
  DATABASE_AUTH: 'entra'
  AZURE_CLIENT_ID: migrationClientId
  POSTGRES_HOST: postgresHost
  POSTGRES_DATABASE: postgresDatabase
  POSTGRES_APP_ROLE: postgresAppRole
  MIGRATION_PRINCIPAL_NAME: migrationPrincipalName
  RUNTIME_PRINCIPAL_ID: runtimePrincipalId
}

resource job 'Microsoft.App/jobs@2025-01-01' = {
  name: jobName
  location: location
  tags: {
    'azd-env-name': environmentName
    application: 'foundry-ai-gateway'
    purpose: 'database-bootstrap'
  }
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${migrationIdentityId}': {}
    }
  }
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Manual'
      replicaRetryLimit: 0
      replicaTimeout: 600
      manualTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
      }
      registries: [
        {
          server: registry.properties.loginServer
          identity: migrationIdentityId
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'migration'
          image: imageName
          command: [
            'node'
            'apps/api/dist/bootstrap.js'
          ]
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: map(items(jobEnvironment), item => {
            name: item.key
            value: item.value
          })
        }
      ]
    }
  }
}

output MIGRATION_JOB_NAME string = job.name
output MIGRATION_JOB_RESOURCE_ID string = job.id
