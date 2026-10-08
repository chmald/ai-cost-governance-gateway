targetScope = 'resourceGroup'

param name string
@minLength(13)
@maxLength(13)
param resourceToken string
param location string
param tags object
param azureTenantId string
param publisherName string
param publisherEmail string
param apimSku string
param apimCapacity int
param entraApiAudience string
param gatewayApiAudience string
param postgresTier string
param postgresSku string
param postgresStorageSizeGB int
param llmTokensPerMinutePerCaller int = 0

module runtimeIdentity 'br/public:avm/res/managed-identity/user-assigned-identity:0.6.0' = {
  name: 'runtime-identity'
  params: {
    name: '${name}-runtime'
    location: location
    tags: tags
    enableTelemetry: false
  }
}

module migrationIdentity 'br/public:avm/res/managed-identity/user-assigned-identity:0.6.0' = {
  name: 'migration-identity'
  params: {
    name: '${name}-migration'
    location: location
    tags: tags
    enableTelemetry: false
  }
}

module registry 'br/public:avm/res/container-registry/registry:0.13.1' = {
  name: 'container-registry'
  params: {
    name: 'cr${resourceToken}'
    location: location
    tags: tags
    enableTelemetry: false
    acrSku: 'Basic'
    acrAdminUserEnabled: false
    anonymousPullEnabled: false
    roleAssignmentMode: 'LegacyRegistryPermissions'
    azureADAuthenticationAsArmPolicyStatus: 'enabled'
    publicNetworkAccess: 'Enabled'
    networkRuleSetDefaultAction: 'Allow'
    zoneRedundancy: 'Disabled'
    retentionPolicyStatus: 'disabled'
    exportPolicyStatus: 'enabled'
    roleAssignments: [
      {
        roleDefinitionIdOrName: 'AcrPull'
        principalId: runtimeIdentity.outputs.principalId
        principalType: 'ServicePrincipal'
      }
      {
        roleDefinitionIdOrName: 'AcrPull'
        principalId: migrationIdentity.outputs.principalId
        principalType: 'ServicePrincipal'
      }
    ]
  }
}

resource postgresNsg 'Microsoft.Network/networkSecurityGroups@2025-05-01' = {
  name: '${name}-postgres'
  location: location
  tags: tags
  properties: {
    securityRules: [
      {
        name: 'AllowContainerAppsPostgres'
        properties: {
          priority: 100
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: '10.42.0.0/23'
          sourcePortRange: '*'
          destinationAddressPrefix: '10.42.2.0/24'
          destinationPortRange: '5432'
        }
      }
      {
        name: 'AllowPostgresInternal'
        properties: {
          priority: 110
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: '10.42.2.0/24'
          sourcePortRange: '*'
          destinationAddressPrefix: '10.42.2.0/24'
          destinationPortRange: '5432'
        }
      }
      {
        name: 'DenyOtherVnetInbound'
        properties: {
          priority: 200
          direction: 'Inbound'
          access: 'Deny'
          protocol: '*'
          sourceAddressPrefix: 'VirtualNetwork'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '*'
        }
      }
    ]
  }
}

resource network 'Microsoft.Network/virtualNetworks@2025-05-01' = {
  name: '${name}-network'
  location: location
  tags: tags
  properties: {
    addressSpace: {
      addressPrefixes: [
        '10.42.0.0/16'
      ]
    }
    subnets: [
      {
        name: 'container-apps'
        properties: {
          addressPrefix: '10.42.0.0/23'
          delegations: [
            {
              name: 'container-apps'
              properties: {
                serviceName: 'Microsoft.App/environments'
              }
            }
          ]
        }
      }
      {
        name: 'postgres'
        properties: {
          addressPrefix: '10.42.2.0/24'
          networkSecurityGroup: {
            id: postgresNsg.id
          }
          serviceEndpoints: [
            {
              service: 'Microsoft.Storage'
              locations: [
                location
              ]
            }
          ]
          delegations: [
            {
              name: 'postgres'
              properties: {
                serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers'
              }
            }
          ]
        }
      }
    ]
  }
}

resource postgresDns 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: 'private-${resourceToken}.postgres.database.azure.com'
  location: 'global'
  tags: tags
}

resource postgresDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: postgresDns
  name: 'gateway-network'
  location: 'global'
  tags: tags
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: network.id
    }
  }
}

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2025-08-01' = {
  name: 'pg-${resourceToken}'
  location: location
  tags: tags
  sku: {
    name: postgresSku
    tier: postgresTier
  }
  properties: {
    version: '17'
    createMode: 'Default'
    authConfig: {
      activeDirectoryAuth: 'Enabled'
      passwordAuth: 'Disabled'
      tenantId: azureTenantId
    }
    network: {
      publicNetworkAccess: 'Disabled'
      delegatedSubnetResourceId: '${network.id}/subnets/postgres'
      privateDnsZoneArmResourceId: postgresDns.id
    }
    storage: {
      storageSizeGB: postgresStorageSizeGB
      type: 'Premium_LRS'
      autoGrow: 'Disabled'
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
  }
  dependsOn: [
    postgresDnsLink
  ]
}

module postgresAdmin 'postgres-admin.bicep' = {
  name: 'postgres-entra-administrator'
  params: {
    serverName: postgres.name
    principalId: migrationIdentity.outputs.principalId
    principalName: migrationIdentity.outputs.name
    tenantId: azureTenantId
  }
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2025-08-01' = {
  parent: postgres
  name: 'gateway'
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
  dependsOn: [
    postgresAdmin
  ]
}

resource logs 'Microsoft.OperationalInsights/workspaces@2025-02-01' = {
  name: '${name}-logs'
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
    features: {
      enableLogAccessUsingOnlyResourcePermissions: true
    }
  }
}

resource environment 'Microsoft.App/managedEnvironments@2025-01-01' = {
  name: '${name}-environment'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
    zoneRedundant: false
    vnetConfiguration: {
      infrastructureSubnetId: '${network.id}/subnets/container-apps'
      internal: false
    }
  }
}

resource apim 'Microsoft.ApiManagement/service@2024-05-01' = {
  name: 'apim-${resourceToken}'
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
    publisherName: publisherName
    publisherEmail: publisherEmail
    publicNetworkAccess: 'Enabled'
    virtualNetworkType: 'None'
    customProperties: apimSku == 'Developer' ? {
      'Microsoft.WindowsAzure.ApiManagement.Gateway.Security.Protocols.Tls10': 'False'
      'Microsoft.WindowsAzure.ApiManagement.Gateway.Security.Protocols.Tls11': 'False'
      'Microsoft.WindowsAzure.ApiManagement.Gateway.Security.Protocols.Ssl30': 'False'
    } : {}
  }
}

resource apiRegistrar 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(resourceGroup().id, apim.name, 'gateway-mcp-api-manager-v1')
  properties: {
    roleName: '${apim.name} MCP API registrar'
    description: 'Register API definitions and policies only; no keys, service administration, deletion or role management.'
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

resource apiRegistrarAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(apim.id, resourceId('Microsoft.ManagedIdentity/userAssignedIdentities', '${name}-runtime'), apiRegistrar.id)
  scope: apim
  properties: {
    principalId: runtimeIdentity.outputs.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: apiRegistrar.id
  }
}

var expectedGatewayUrl = 'https://${name}.${environment.properties.defaultDomain}'

module observability '../../modules/observability.bicep' = {
  name: 'gateway-observability'
  params: {
    name: '${name}-insights'
    location: location
    tags: tags
    logAnalyticsWorkspaceId: logs.id
    apimServiceName: apim.name
  }
}

module gatewayPolicies '../../modules/gateway.bicep' = {
  name: 'gateway-policies'
  params: {
    apimServiceName: apim.name
    appBackendUrl: expectedGatewayUrl
    azureTenantId: azureTenantId
    entraApiAudience: entraApiAudience
    gatewayApiAudience: gatewayApiAudience
    apimLoggerId: observability.outputs.apimLoggerId
    llmTokensPerMinutePerCaller: llmTokensPerMinutePerCaller
  }
}

output registryName string = registry.outputs.name
output registryEndpoint string = registry.outputs.loginServer
output environmentName string = environment.name
output environmentId string = environment.id
output gatewayUrl string = expectedGatewayUrl
output apimName string = apim.name
output apimGatewayUrl string = apim.properties.gatewayUrl
output apimPrincipalId string = apim.identity.principalId
output runtimeIdentityId string = runtimeIdentity.outputs.resourceId
output runtimeClientId string = runtimeIdentity.outputs.clientId
output runtimePrincipalId string = runtimeIdentity.outputs.principalId
output migrationIdentityId string = migrationIdentity.outputs.resourceId
output migrationClientId string = migrationIdentity.outputs.clientId
output migrationPrincipalId string = migrationIdentity.outputs.principalId
output migrationPrincipalName string = migrationIdentity.outputs.name
output postgresHost string = postgres.properties.fullyQualifiedDomainName
output postgresDatabase string = database.name
output databaseUrl string = 'postgresql://gateway_app@${postgres.properties.fullyQualifiedDomainName}:5432/${database.name}?sslmode=verify-full'
output logAnalyticsWorkspaceId string = logs.id
output applicationInsightsName string = observability.outputs.applicationInsightsName
output applicationInsightsId string = observability.outputs.applicationInsightsId
