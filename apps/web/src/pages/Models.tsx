import { useState, type FormEvent } from "react";
import type { GatewayApi } from "../api";
import { Empty, ErrorNotice, Field, FormActions, Loading, PageHeading, ReadOnly, SaveNotice, StatusBadge, identifier, required, useResource } from "../components";
import { formatUsd, parseUsd, positiveInteger, usdInput, utcTime } from "../money";
import type { Model, ModelGovernance, ModelInput } from "../types";

const supportedSkus = ["Standard", "GlobalStandard", "DataZoneStandard"] as const;

export function ModelsPage({ api, admin, demo }: { api: GatewayApi; admin: boolean; demo: boolean }) {
  const state = useResource(api.models);
  const [editing, setEditing] = useState<Model | "new" | null>(null);
  const [success, setSuccess] = useState("");
  return <>
    <PageHeading eyebrow="GOVERNANCE / MODELS" title="Model deployments"
      description="Deploy within the configured Foundry account. Set verified prices and access controls."
      actions={<><button className="button secondary" disabled={state.loading || !!editing} onClick={state.refresh}>Refresh status</button>{admin && <button className="button primary" disabled={!!editing || !state.data} onClick={() => { setEditing("new"); setSuccess(""); }}>+ Create deployment</button>}</>} />
    <ReadOnly admin={admin} />
    <SaveNotice message={success} />
    {state.loading && <Loading />}
    {state.error !== undefined && <ErrorNotice error={state.error} onRetry={state.refresh} />}
    {state.data && <>
      {editing && admin && <ModelForm key={editing === "new" ? "new" : editing.id} model={editing === "new" ? undefined : editing}
        api={api} demo={demo} onCancel={() => setEditing(null)} onSaved={() => {
          setSuccess(editing === "new"
            ? `${demo ? "Local demo" : "Deployment"} request accepted. Refresh status to check readiness; acceptance does not mean provisioning has completed.`
            : "Pricing and governance saved. New requests use the gateway's current policy.");
          setEditing(null); state.refresh();
        }} />}
      <div className="notice notice-info"><strong>Verified prices, bounded reservations</strong><p>Prices are USD per 1 million tokens. Only verified, on-demand text deployments are eligible. Provisioned throughput, hosting fees, and external-provider charges are outside this token ledger. Expired prices or disabled models cannot serve new requests; configured prices do not control the Azure invoice.</p></div>
      {state.data.length === 0 ? <Empty title="No model deployments">Create a deployment with verified pricing, context limits, and a pricing expiration date. New deployments start disabled unless explicitly enabled.</Empty> :
        <div className="model-grid">{state.data.map((model) => {
          const expired = !Number.isFinite(Date.parse(model.pricingValidUntil)) || Date.parse(model.pricingValidUntil) <= Date.now();
          return <article className="card model-card" key={model.id}>
            <div className="model-card-top"><span className="model-monogram" aria-hidden="true">AI</span><StatusBadge tone={!model.enabled || expired ? "warning" : "neutral"}>{!model.enabled ? "Disabled" : expired ? "Pricing expired" : "Enabled"}</StatusBadge></div>
            <h2>{model.displayName}</h2><p className="mono muted">{model.id}</p>
            <dl className="detail-list"><div><dt>Deployment</dt><dd>{model.deploymentName}</dd></div><div><dt>Model / version</dt><dd>{model.modelName} / {model.modelVersion}</dd></div><div><dt>Provider status</dt><dd>{model.status}</dd></div></dl>
            <div className="model-prices"><div><span>Input / 1M tokens</span><strong>{formatUsd(model.inputPriceMicrosPerMillion)}</strong></div><div><span>Output / 1M tokens</span><strong>{formatUsd(model.outputPriceMicrosPerMillion)}</strong></div></div>
            <dl className="detail-list"><div><dt>Context window</dt><dd>{model.contextWindowTokens.toLocaleString("en-US")} tokens</dd></div><div><dt>Maximum output</dt><dd>{model.maxOutputTokens.toLocaleString("en-US")} tokens</dd></div><div><dt>Pricing valid until</dt><dd>{utcTime(model.pricingValidUntil)}</dd></div></dl>
            {admin && <button className="button secondary full-width" disabled={!!editing} onClick={() => { setEditing(model); setSuccess(""); }} aria-label={`Edit pricing and governance for ${model.displayName}`}>Edit pricing & governance</button>}
          </article>;
        })}</div>}
    </>}
  </>;
}

export function ModelForm({ model, api, demo, onCancel, onSaved }: {
  model?: Model; api: GatewayApi; demo: boolean; onCancel: () => void; onSaved: () => void;
}) {
  const [error, setError] = useState<unknown>();
  const [pending, setPending] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setError(undefined);
    try {
      const expires = required(data, "pricingValidUntil", "Pricing valid-until time");
      const date = new Date(`${expires}Z`);
      if (!Number.isFinite(date.valueOf())) throw new Error("Enter a valid pricing expiration in UTC.");
      const enabled = data.get("enabled") === "on";
      if (enabled && date.valueOf() <= Date.now()) throw new Error("Enabled models require a pricing valid-until time in the future.");
      const governance: ModelGovernance = {
        displayName: required(data, "displayName", "Display name"),
        inputPriceMicrosPerMillion: parseUsd(required(data, "inputPrice", "Input price")),
        outputPriceMicrosPerMillion: parseUsd(required(data, "outputPrice", "Output price")),
        contextWindowTokens: positiveInteger(required(data, "contextWindowTokens", "Context window"), "Context window"),
        maxOutputTokens: positiveInteger(required(data, "maxOutputTokens", "Maximum output"), "Maximum output"),
        pricingValidUntil: date.toISOString(), enabled,
      };
      if (governance.maxOutputTokens > governance.contextWindowTokens) throw new Error("Maximum output tokens cannot exceed the context window.");
      let input: ModelInput | undefined;
      if (!model) {
        const sku = required(data, "sku", "Deployment SKU");
        if (!supportedSkus.some((supported) => supported === sku)) {
          throw new Error("Only Standard, GlobalStandard, and DataZoneStandard on-demand SKUs are supported. Provisioned throughput cannot use this token-only budget ledger.");
        }
        input = {
          ...governance, id: identifier(data, "id", "Model ID"),
          deploymentName: identifier(data, "deploymentName", "Deployment name"),
          modelName: required(data, "modelName", "Foundry model name"),
          modelVersion: required(data, "modelVersion", "Model version"),
          sku, capacity: positiveInteger(required(data, "capacity", "Capacity"), "Capacity"),
        };
      }
      setPending(true);
      if (model) await api.updateModel(model.id, governance);
      else await api.createModel(input!);
      onSaved();
    } catch (cause) { setError(cause); }
    finally { setPending(false); }
  }
  const validUntil = model && Number.isFinite(Date.parse(model.pricingValidUntil))
    ? new Date(model.pricingValidUntil).toISOString().slice(0, 16) : "";
  return <section className="card editor" aria-labelledby="model-form-title"><h2 id="model-form-title">{model ? `Edit ${model.displayName}` : "Create a model deployment"}</h2>
    <p className="muted">{model ? "Deployment identity is immutable. Update the pricing and governance of future requests." : demo ? "Demo mode: creates a local record only. No deployment or other Azure change is made." : "Creates a deployment in the operator-configured existing Foundry account. Provisioning may incur Azure charges."}</p>
    <form onSubmit={submit} noValidate>
      {error !== undefined && <ErrorNotice error={error} />}
      <fieldset disabled={pending}><legend className="sr-only">Deployment configuration</legend><div className="form-grid">
        {!model && <Field label="Model ID" hint="The stable gateway model identifier."><input name="id" maxLength={64} required /></Field>}
        <Field label="Display name"><input name="displayName" required maxLength={120} defaultValue={model?.displayName} /></Field>
        {!model && <>
          <Field label="Deployment name"><input name="deploymentName" required maxLength={64} /></Field>
          <Field label="Foundry model name" hint="A supported text-chat model available in the configured account. The backend validates model eligibility."><input name="modelName" required /></Field>
          <Field label="Model version" hint="An explicit supported version, not a floating alias."><input name="modelVersion" required /></Field>
          <Field label="Deployment SKU" hint="Verified on-demand deployments only. Provisioned throughput and fixed hosting charges are not covered."><select name="sku" required defaultValue=""><option value="">Select an on-demand SKU</option>{supportedSkus.map((sku) => <option key={sku} value={sku}>{sku}</option>)}</select></Field>
          <Field label="Capacity" hint="SKU-specific capacity units; verify quota first."><input name="capacity" inputMode="numeric" required /></Field>
        </>}
        <Field label="Input price (USD / 1M tokens)" hint="Verified rate; up to 6 decimal places."><input name="inputPrice" inputMode="decimal" required defaultValue={model ? usdInput(model.inputPriceMicrosPerMillion) : ""} /></Field>
        <Field label="Output price (USD / 1M tokens)" hint="Verified rate; up to 6 decimal places."><input name="outputPrice" inputMode="decimal" required defaultValue={model ? usdInput(model.outputPriceMicrosPerMillion) : ""} /></Field>
        <Field label="Context window (tokens)" hint="Actual deployment limit, used for conservative reservations."><input name="contextWindowTokens" inputMode="numeric" required defaultValue={model?.contextWindowTokens} /></Field>
        <Field label="Maximum output (tokens)" hint="The completion-token limit includes visible output and reasoning tokens."><input name="maxOutputTokens" inputMode="numeric" required defaultValue={model?.maxOutputTokens} /></Field>
        <Field label="Pricing valid until (UTC)" hint="New inference is blocked after this time. The entered time is UTC, not your local timezone."><input type="datetime-local" name="pricingValidUntil" required defaultValue={validUntil} /></Field>
      </div><label className="check-row enabled-check"><input type="checkbox" name="enabled" defaultChecked={model?.enabled ?? false} /><span>Enable for new requests<small>Team allowlists and readiness checks still apply. Leave disabled until pricing and limits are verified.</small></span></label></fieldset>
      <FormActions pending={pending} onCancel={onCancel} submitLabel={model ? "Save governance" : demo ? "Create demo deployment" : "Request deployment"} />
    </form></section>;
}
