const fail = () => { throw new Error('EVENTARC_DATA_WRITE_AUDIT_UNCONFIRMED'); };
function applicable(policy) {
  if (!policy || (policy.auditConfigs !== undefined && !Array.isArray(policy.auditConfigs))) fail();
  const result = (policy.auditConfigs ?? []).filter(config => ['allServices', 'eventarc.googleapis.com'].includes(config?.service));
  if (new Set(result.map(config => config.service)).size !== result.length) fail();
  for (const config of result) {
    if (Object.keys(config).some(key => !['service', 'auditLogConfigs'].includes(key)) ||
      (config.auditLogConfigs !== undefined && !Array.isArray(config.auditLogConfigs))) fail();
    const logs = config.auditLogConfigs ?? [];
    if (new Set(logs.map(log => log?.logType)).size !== logs.length) fail();
    for (const log of logs) if (log?.logType === 'DATA_WRITE') {
      if (Object.keys(log).some(key => !['logType', 'exemptedMembers'].includes(key)) ||
        (log.exemptedMembers !== undefined && (!Array.isArray(log.exemptedMembers) || log.exemptedMembers.length))) fail();
    }
  }
  return result;
}
/** Applicable exemptions are never removed or overridden by another config. */
export function requireEventarcWriteAudit(policy) {
  if (!applicable(policy).some(config => config.auditLogConfigs?.some(log => log.logType === 'DATA_WRITE'))) fail();
}
/** Add exactly the missing Eventarc write log. Preserve other audit content. */
export function addEventarcWriteAudit(policy) {
  const configs = applicable(policy);
  const result = structuredClone(policy);
  if (configs.some(config => config.auditLogConfigs?.some(log => log.logType === 'DATA_WRITE'))) return result;
  result.auditConfigs ??= [];
  let target = result.auditConfigs.find(config => config.service === 'eventarc.googleapis.com');
  if (!target) { target = { service: 'eventarc.googleapis.com', auditLogConfigs: [] }; result.auditConfigs.push(target); }
  target.auditLogConfigs ??= [];
  target.auditLogConfigs.push({ logType: 'DATA_WRITE' });
  requireEventarcWriteAudit(result);
  return result;
}
