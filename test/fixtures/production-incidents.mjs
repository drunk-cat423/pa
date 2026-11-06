// Minimal anonymized reproductions of recorded incidents, not a production-data export.
// Original names/IDs/private context remain in .local/server-audit-20261026/.
// Four real responses omitted f44; one replaced f44 but also omitted f24.
// This fixture retains their reference structure, not private profile prose.
export const profileOmissionIncidents = [44, 44, 44, 44, 24].map((omitted, index) => ({
  id: `profile-omission-${index + 1}`, omitted,
  proposal: { ...(index === 1 ? { type: 'json_object' } : {}), facts: Array.from({ length: 46 }, (_, n) => n).flatMap(n => {
    if (index === 4 && n === 24) return [{ content: '已脱敏的使用统计描述', sources: ['m0'], replaces: ['f44'] }];
    if (n === 44) return [];
    return [{ keep: `f${n}` }];
  }) },
}));
