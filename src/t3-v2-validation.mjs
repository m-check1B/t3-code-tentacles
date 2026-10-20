// Closed schema records at the V1 -> V2 boundary. Option IDs and answer IDs are
// user/provider data, not schema keys. Validate before builders can drop fields.
export function validateNestedRecords(value, refuse) {
  const record = (v, keys, label) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) refuse(`${label} must be a record`);
    for (const key of Object.keys(v)) if (!keys.includes(key)) refuse(`unknown ${label} field: ${key}`);
  };
  const array = (v, check, label) => {
    if (!Array.isArray(v)) refuse(`${label} must be an array`);
    v.forEach(check);
  };
  const options = (v) => {
    // Canonical options emitted by Tentacles are arrays; arbitrary IDs stay data.
    array(v, (option) => {
      record(option, ['id', 'value'], 'model option');
      if (typeof option.id !== 'string' || !['string', 'boolean'].includes(typeof option.value)) refuse('model option requires a string ID and string/boolean value');
    }, 'model options');
  };
  const selection = (v, label) => {
    record(v, ['instanceId', 'model', 'options'], label);
    if (v.options !== undefined) options(v.options);
  };
  const node = (v, depth = 0) => {
    if (depth > 64) refuse('accessibility tree exceeds supported depth');
    record(v, ['role', 'name', 'value', 'description', 'bounds', 'state', 'actions', 'children'], 'accessibility node');
    if (v.bounds != null) record(v.bounds, ['x', 'y', 'width', 'height'], 'accessibility bounds');
    if (v.state !== undefined) record(v.state, ['active', 'busy', 'checked', 'editable', 'enabled', 'expanded', 'focused', 'selected', 'visible'], 'accessibility state');
    if (v.children !== undefined) array(v.children, (child) => node(child, depth + 1), 'accessibility children');
  };
  const attachment = (v) => {
    record(v, ['type', 'id', 'name', 'mimeType', 'sizeBytes', 'source'], 'attachment');
    if (!['file', 'image'].includes(v.type)) refuse('unsupported attachment type');
    if (v.source === undefined) return;
    if (v.type === 'file') {
      record(v.source, ['type'], 'file source');
      if (v.source.type !== 'pasted-text') refuse('unsupported file source');
      return;
    }
    record(v.source, ['kind', 'capturedAt', 'appName', 'windowTitle', 'accessibleText', 'accessibility', 'appIdentifier', 'appIconDataUrl'], 'image source');
    if (v.source.kind !== 'snap-shot') refuse('unsupported image source');
    const a = v.source.accessibility;
    if (a === undefined) return;
    if (a?.format === 'flat-text') record(a, ['format', 'text', 'truncated'], 'accessibility');
    else if (a?.format === 'element-tree') {
      record(a, ['format', 'coordinateSpace', 'imageSize', 'truncated', 'root'], 'accessibility');
      record(a.imageSize, ['width', 'height'], 'accessibility image size');
      node(a.root);
    } else refuse('unsupported accessibility format');
  };
  for (const key of ['modelSelection', 'defaultModelSelection']) {
    if (value[key] != null) selection(value[key], key);
  }
  if (value.options !== undefined) options(value.options);
  if (value.message !== undefined) {
    record(value.message, ['messageId', 'role', 'text', 'attachments'], 'turn message');
    if (value.message.attachments !== undefined) array(value.message.attachments, attachment, 'attachments');
  }
  if (value.scripts !== undefined) array(value.scripts, (script) => record(script,
    ['id', 'name', 'command', 'icon', 'runOnWorktreeCreate', 'runOnSettle', 'async', 'previewUrl', 'autoOpenPreview'], 'project script'), 'project scripts');
}
