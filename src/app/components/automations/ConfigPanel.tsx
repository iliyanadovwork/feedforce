'use client';

import { useState } from 'react';
import { TextField, Textarea, Select, Switch, Alert, Button } from '@/app/components/ui';
import { isParamVisible, type NodeParam, type ParamOption } from '@/lib/automations';
import type { NodeDescriptor } from '@/lib/automations/descriptors';
import type { CredentialMeta } from '../AutomationsSection';
import { CodeEditor } from './CodeEditor';

// Renders a node's parameters into a form, honouring displayOptions. Phase 1 covers the param types
// the starter descriptors use; `code`/`json` are plain mono textareas here (Monaco lands with the
// Code tab in a later phase). `dynamicOptions` supplies choices for options fields whose
// typeOptions.loadOptionsMethod names a runtime source (e.g. 'templates').
export function ConfigPanel({ descriptor, config, onChange, dynamicOptions, credentials, onCreateCredential }: {
  descriptor: NodeDescriptor;
  config: Record<string, unknown>;
  onChange: (name: string, value: unknown) => void;
  dynamicOptions?: Record<string, ParamOption[]>;
  credentials?: CredentialMeta[];
  onCreateCredential?: (label: string, secret: string, kind?: string) => Promise<string>;
}) {
  const visible = descriptor.parameters.filter(p => isParamVisible(p, config));
  return (
    <div className="flex flex-col gap-4">
      {visible.map(param => <Field key={param.name} param={param} value={config[param.name]} onChange={v => onChange(param.name, v)} dynamicOptions={dynamicOptions} credentials={credentials} onCreateCredential={onCreateCredential} />)}
      {visible.length === 0 && <p className="text-caption text-fg-3">No settings for this node.</p>}
    </div>
  );
}

function Field({ param, value, onChange, dynamicOptions, credentials, onCreateCredential }: {
  param: NodeParam; value: unknown; onChange: (v: unknown) => void; dynamicOptions?: Record<string, ParamOption[]>;
  credentials?: CredentialMeta[]; onCreateCredential?: (label: string, secret: string, kind?: string) => Promise<string>;
}) {
  const { type, displayName, description, placeholder, required } = param;

  if (type === 'notice') {
    return <Alert tone="info">{String(param.default ?? description ?? '')}</Alert>;
  }

  if (type === 'credential') {
    return <CredentialField label={label(displayName, required)} helper={description} value={typeof value === 'string' ? value : ''}
      onChange={onChange} credentials={credentials ?? []} onCreate={onCreateCredential} />;
  }

  if (type === 'boolean') {
    return (
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <span className="text-label text-fg-2">{displayName}</span>
          {description && <p className="text-caption text-fg-3">{description}</p>}
        </div>
        <Switch checked={Boolean(value)} onChange={onChange} label={displayName} />
      </div>
    );
  }

  if (type === 'options') {
    const method = param.typeOptions?.loadOptionsMethod;
    const dyn = method ? dynamicOptions?.[method] : undefined;
    const opts: ParamOption[] = dyn ?? param.options ?? [];
    return (
      <Select label={label(displayName, required)} helper={description} value={String(value ?? '')} onChange={e => onChange(e.target.value)}>
        <option value="" disabled hidden>{opts.length ? 'Select…' : method ? 'None available yet' : 'Select…'}</option>
        {opts.map(o => <option key={String(o.value)} value={String(o.value)}>{o.name}</option>)}
      </Select>
    );
  }

  if (type === 'code') {
    // Syntax-highlighted editor (IDE-style colours) — same value plumbing as the plain textarea.
    return (
      <div className="flex flex-col gap-1.5">
        <span className="text-label text-fg-2">{label(displayName, required)}</span>
        <CodeEditor
          value={typeof value === 'string' ? value : value != null ? JSON.stringify(value, null, 2) : ''}
          onChange={onChange}
          rows={param.typeOptions?.rows ?? 12}
          placeholder={placeholder}
          ariaLabel={displayName}
        />
        {description && <span className="text-caption text-fg-4">{description}</span>}
      </div>
    );
  }

  if (type === 'json') {
    return (
      <Textarea
        label={label(displayName, required)}
        helper={description}
        rows={param.typeOptions?.rows ?? 4}
        placeholder={placeholder}
        value={typeof value === 'string' ? value : value != null ? JSON.stringify(value, null, 2) : ''}
        onChange={e => onChange(e.target.value)}
        className="font-mono text-[12px]"
      />
    );
  }

  if (type === 'number') {
    return (
      <TextField type="number" label={label(displayName, required)} helper={description} placeholder={placeholder}
        value={value === undefined || value === null ? '' : String(value)}
        onChange={e => onChange(e.target.value === '' ? undefined : Number(e.target.value))} />
    );
  }

  // string | resourceLocator | dateTime | color | fallback
  return (
    <TextField
      type={type === 'dateTime' ? 'datetime-local' : 'text'}
      label={label(displayName, required)}
      helper={description ?? (type === 'resourceLocator' ? 'Pick a FeedForce template (id for now).' : undefined)}
      placeholder={placeholder ?? (type === 'resourceLocator' ? 'template id' : undefined)}
      value={typeof value === 'string' ? value : ''}
      onChange={e => onChange(e.target.value)}
    />
  );
}

// Credential picker: choose a stored credential or add a new one. Only the credential id is stored in
// the flow; the secret is sent once to the server (encrypted at rest) and never read back. Exported so
// the guided-builder wizard (ChatPanel) reuses the exact same picker/creator.
export function CredentialField({ label: lbl, helper, value, onChange, credentials, onCreate }: {
  label: string; helper?: string; value: string; onChange: (v: unknown) => void;
  credentials: CredentialMeta[]; onCreate?: (label: string, secret: string, kind?: string) => Promise<string>;
}) {
  const [adding, setAdding] = useState(false);
  const [credLabel, setCredLabel] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    if (!onCreate || !secret.trim()) return;
    setBusy(true); setErr(null);
    try {
      const id = await onCreate(credLabel.trim() || 'API key', secret.trim());
      onChange(id);
      setAdding(false); setCredLabel(''); setSecret('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to save');
    } finally { setBusy(false); }
  }

  if (adding) {
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-line bg-page p-3">
        <span className="text-label text-fg-2">New {lbl}</span>
        <TextField label="Name" placeholder="e.g. Stock API key" value={credLabel} onChange={e => setCredLabel(e.target.value)} />
        <TextField type="password" label="Secret" placeholder="••••••••" value={secret} onChange={e => setSecret(e.target.value)} />
        {err && <Alert tone="danger">{err}</Alert>}
        <div className="flex gap-2">
          <Button size="sm" variant="primary" loading={busy} onClick={save}>Save</Button>
          <Button size="sm" variant="ghost" onClick={() => { setAdding(false); setErr(null); }}>Cancel</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-end gap-2">
      <div className="min-w-0 flex-1">
        <Select label={lbl} helper={helper} value={value} onChange={e => onChange(e.target.value)}>
          <option value="" disabled hidden>{credentials.length ? 'Select a credential…' : 'No credentials yet'}</option>
          {credentials.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
        </Select>
      </div>
      <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>＋ New</Button>
    </div>
  );
}

function label(name: string, required?: boolean): string {
  return required ? `${name} *` : name;
}
