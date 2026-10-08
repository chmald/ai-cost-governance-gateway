targetScope = 'resourceGroup'

param apimServiceName string
param appBackendUrl string
param azureTenantId string
param entraApiAudience string
param gatewayApiAudience string

@description('APIM Application Insights logger resource ID (see observability.bicep). Enables inference diagnostics and llm-emit-token-metric.')
param apimLoggerId string

@description('Optional per-caller (token oid) llm-token-limit in tokens per minute. 0 disables it. Complements, never replaces, the prepaid USD ledger.')
@minValue(0)
@maxValue(100000000)
param llmTokensPerMinutePerCaller int = 0

resource apim 'Microsoft.ApiManagement/service@2024-05-01' existing = {
  name: apimServiceName
}

// Optional complementary throttle. Actual usage from the response is counted (no prompt estimation),
// so the prepaid ledger remains the admission authority for spend.
var tokenLimitPolicy = '<llm-token-limit counter-key="@(&quot;llm-tokens:&quot; + ((Jwt)context.Variables[&quot;callerJwt&quot;]).Claims.GetValueOrDefault(&quot;oid&quot;, &quot;&quot;))" tokens-per-minute="${llmTokensPerMinutePerCaller}" estimate-prompt-tokens="false" remaining-tokens-header-name="x-ratelimit-remaining-tokens" />'
var inferencePolicyXml = replace(loadTextContent('../policies/inference.xml'), '<!-- optional-llm-token-limit -->',
  llmTokensPerMinutePerCaller > 0 ? tokenLimitPolicy : '<!-- llm-token-limit disabled (llmTokensPerMinutePerCaller = 0) -->')

var namedValues = {
  'entra-tenant-id': azureTenantId
  'entra-api-audience': entraApiAudience
  'gateway-api-audience': gatewayApiAudience
}

resource settings 'Microsoft.ApiManagement/service/namedValues@2024-05-01' = [for item in items(namedValues): {
  parent: apim
  name: item.key
  properties: {
    displayName: item.key
    value: item.value
    secret: false
  }
}]

resource inferenceApi 'Microsoft.ApiManagement/service/apis@2024-05-01' = {
  parent: apim
  name: 'gateway-inference'
  properties: {
    displayName: 'Budget-governed chat completions'
    description: 'Calls the ledger-backed application, never a Foundry endpoint directly.'
    type: 'http'
    path: 'openai/v1'
    protocols: [
      'https'
    ]
    serviceUrl: '${appBackendUrl}/openai/v1'
    subscriptionRequired: false
  }
}

resource chat 'Microsoft.ApiManagement/service/apis/operations@2024-05-01' = {
  parent: inferenceApi
  name: 'chat-completions'
  properties: {
    displayName: 'Create a budget-governed chat completion'
    method: 'POST'
    urlTemplate: '/chat/completions'
    responses: []
  }
}

resource inferencePolicy 'Microsoft.ApiManagement/service/apis/policies@2024-05-01' = {
  parent: inferenceApi
  name: 'policy'
  properties: {
    format: 'rawxml'
    value: inferencePolicyXml
  }
  dependsOn: [
    settings
    chat
    inferenceDiagnostics
  ]
}

// metrics: true lets llm-emit-token-metric publish custom metrics. Metadata only: no headers or bodies are logged.
resource inferenceDiagnostics 'Microsoft.ApiManagement/service/apis/diagnostics@2024-05-01' = {
  parent: inferenceApi
  name: 'applicationinsights'
  properties: {
    loggerId: apimLoggerId
    alwaysLog: 'allErrors'
    httpCorrelationProtocol: 'W3C'
    logClientIp: false
    metrics: true
    verbosity: 'error'
    sampling: {
      samplingType: 'fixed'
      percentage: 100
    }
    frontend: {
      request: {
        headers: []
        body: {
          bytes: 0
        }
      }
      response: {
        headers: []
        body: {
          bytes: 0
        }
      }
    }
    backend: {
      request: {
        headers: []
        body: {
          bytes: 0
        }
      }
      response: {
        headers: []
        body: {
          bytes: 0
        }
      }
    }
  }
}

resource backingApi 'Microsoft.ApiManagement/service/apis@2024-05-01' = {
  parent: apim
  name: 'gateway-readonly-tools'
  properties: {
    displayName: 'Read-only governance tool operations'
    description: 'Only principal-filtered models and budgets; no management or inference operations.'
    type: 'http'
    path: 'mcp-tools'
    protocols: [
      'https'
    ]
    serviceUrl: '${appBackendUrl}/mcp-tools'
    subscriptionRequired: false
  }
}

var tools = [
  {
    name: 'models'
    displayName: 'list_models'
    description: 'Read enabled model deployments visible to the authenticated principal.'
  }
  {
    name: 'budget'
    displayName: 'read_budget'
    description: 'Read current budgets of teams containing the authenticated principal.'
  }
]

resource operations 'Microsoft.ApiManagement/service/apis/operations@2024-05-01' = [for tool in tools: {
  parent: backingApi
  name: tool.name
  properties: {
    displayName: tool.displayName
    description: tool.description
    method: 'GET'
    urlTemplate: '/${tool.name}'
    responses: [
      {
        statusCode: 200
        description: 'Principal-filtered read-only result.'
        representations: [
          {
            contentType: 'application/json'
          }
        ]
      }
    ]
  }
}]

resource backingPolicy 'Microsoft.ApiManagement/service/apis/policies@2024-05-01' = {
  parent: backingApi
  name: 'policy'
  properties: {
    format: 'rawxml'
    value: loadTextContent('../policies/readonly-tools.xml')
  }
  dependsOn: [
    settings
    operations
  ]
}

resource mcpApi 'Microsoft.ApiManagement/service/apis@2025-09-01-preview' = {
  parent: apim
  name: 'gateway-governance-mcp'
  properties: {
    type: 'mcp'
    displayName: 'Read-only gateway governance'
    description: 'Read-only tools. This server does not expose administration or inference.'
    path: 'mcp/governance'
    protocols: [
      'https'
    ]
    subscriptionRequired: false
  }
}

resource mcpTools 'Microsoft.ApiManagement/service/apis/tools@2025-09-01-preview' = [for (tool, index) in tools: {
  parent: mcpApi
  name: tool.displayName
  properties: {
    displayName: tool.displayName
    description: tool.description
    operationId: operations[index].id
  }
  dependsOn: [
    backingPolicy
  ]
}]

resource mcpPolicy 'Microsoft.ApiManagement/service/apis/policies@2025-09-01-preview' = {
  parent: mcpApi
  name: 'policy'
  properties: {
    format: 'rawxml'
    value: loadTextContent('../policies/readonly-tools.xml')
  }
  dependsOn: [
    settings
    mcpTools
  ]
}
