targetScope = 'resourceGroup'

@description('Optional, separately invoked bootstrap. Push the tested application image here BEFORE deploying main.bicep.')
@minLength(5)
@maxLength(50)
param registryName string

param location string = resourceGroup().location

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: registryName
  location: location
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: false
  }
}

output loginServer string = registry.properties.loginServer
