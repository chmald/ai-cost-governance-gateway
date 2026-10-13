targetScope = 'resourceGroup'

param location string
param tags object
param accountName string
param projectName string

resource account 'Microsoft.CognitiveServices/accounts@2025-06-01' = {
  name: accountName
  location: location
  tags: tags
  kind: 'AIServices'
  sku: {
    name: 'S0'
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    allowProjectManagement: true
    customSubDomainName: accountName
    disableLocalAuth: true
    // The isolated ACA network uses public HTTPS egress; no private Foundry route is implied.
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      defaultAction: 'Allow'
      bypass: 'None'
      ipRules: []
      virtualNetworkRules: []
    }
  }
}

resource project 'Microsoft.CognitiveServices/accounts/projects@2025-06-01' = {
  parent: account
  name: projectName
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    displayName: projectName
    description: 'Dedicated AI cost governance gateway demo project; model deployments and pricing are managed in the gateway portal.'
  }
}

output endpoint string = 'https://${account.name}.services.ai.azure.com/'
output projectEndpoint string = 'https://${account.name}.services.ai.azure.com/api/projects/${project.name}'
