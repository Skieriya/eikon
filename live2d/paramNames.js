// The same control is spelled differently from rig to rig: the Cubism samples
// use ParamAngleX, Cubism-2 style and older exports use PARAM_ANGLE_X. Naming
// one convention would silently disable tracking on models that use the other,
// so names are compared after canonicalising - drop the Param prefix, drop every
// separator, lowercase - and ParamAngleX, PARAM_ANGLE_X and param_angle_x all
// arrive at "anglex".

export function canonicalParamName(name) {
  return String(name).replace(/^param[_]?/i, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

// Index a model's parameters by canonical name. This also sidesteps the SDK
// quirk where getParameterIndex hands out out-of-range indices for ids the moc
// does not know: every answer here comes from the model's own parameter list,
// together with the model's own spelling of it (needed for setId lookups).
export function createParamLookup(model) {
  const byKey = new Map();
  const entries = [];
  const count = model.getParameterCount();
  for (let i = 0; i < count; i++) {
    const pid = model.getParameterId(i);
    const name = (pid && (pid._id || (pid.getString && pid.getString()))) || '';
    const key = canonicalParamName(name);
    const entry = { index: i, name, key };
    entries.push(entry);
    if (key && !byKey.has(key)) byKey.set(key, entry);
  }
  return {
    entries,
    // { index, name } for the first parameter matching `name` (any spelling), or null.
    find(name) { return byKey.get(canonicalParamName(name)) || null; },
  };
}
