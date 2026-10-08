targetScope = 'resourceGroup'

param accountName string
param appPrincipalId string
param appIdentityResourceId string

resource account 'Microsoft.CognitiveServices/accounts@2025-06-01' existing = {
  name: accountName
}

resource deploymentManager 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(resourceGroup().id, account.id, 'gateway-deployment-manager-v1')
  properties: {
    roleName: '${accountName} gateway deployment manager'
    description: 'Read this account and read/write model deployments; cannot create/delete accounts, delete deployments, or list keys.'
    type: 'CustomRole'
    assignableScopes: [
      resourceGroup().id
    ]
    permissions: [
      {
        actions: [
          'Microsoft.CognitiveServices/accounts/read'
          'Microsoft.CognitiveServices/accounts/deployments/read'
          'Microsoft.CognitiveServices/accounts/deployments/write'
        ]
        notActions: []
        dataActions: []
        notDataActions: []
      }
    ]
  }
}

resource deploymentAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(account.id, appIdentityResourceId, deploymentManager.id)
  scope: account
  properties: {
    principalId: appPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: deploymentManager.id
  }
}

resource inferenceAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(account.id, appIdentityResourceId, 'openai-user')
  scope: account
  properties: {
    principalId: appPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd')
  }
}
