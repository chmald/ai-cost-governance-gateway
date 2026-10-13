targetScope = 'resourceGroup'

param name string
param location string
param tags object
param postgresNetworkName string
param postgresDnsZoneName string

resource postgresNetwork 'Microsoft.Network/virtualNetworks@2025-05-01' existing = {
  name: postgresNetworkName
}

resource postgresDns 'Microsoft.Network/privateDnsZones@2024-06-01' existing = {
  name: postgresDnsZoneName
}

resource network 'Microsoft.Network/virtualNetworks@2025-05-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    addressSpace: {
      addressPrefixes: [
        '10.43.0.0/16'
      ]
    }
    subnets: [
      {
        name: 'container-apps'
        properties: {
          addressPrefix: '10.43.0.0/23'
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
    ]
  }
}

resource toPostgres 'Microsoft.Network/virtualNetworks/virtualNetworkPeerings@2025-05-01' = {
  parent: network
  name: 'to-postgres'
  properties: {
    remoteVirtualNetwork: {
      id: postgresNetwork.id
    }
    allowVirtualNetworkAccess: true
    allowForwardedTraffic: false
    allowGatewayTransit: false
    useRemoteGateways: false
  }
}

resource toContainerApps 'Microsoft.Network/virtualNetworks/virtualNetworkPeerings@2025-05-01' = {
  parent: postgresNetwork
  name: 'to-container-apps'
  properties: {
    remoteVirtualNetwork: {
      id: network.id
    }
    allowVirtualNetworkAccess: true
    allowForwardedTraffic: false
    allowGatewayTransit: false
    useRemoteGateways: false
  }
  dependsOn: [
    toPostgres
  ]
}

resource dnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: postgresDns
  name: 'container-apps-network'
  location: 'global'
  tags: tags
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: network.id
    }
  }
}

output subnetId string = '${network.id}/subnets/container-apps'
