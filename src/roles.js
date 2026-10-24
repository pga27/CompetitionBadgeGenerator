// Role mapping: turns a person's WCIF roles into the single "role" value
// templates use (text, colors, backgrounds…). Rules are checked top to
// bottom and the first match wins. A rule's wcaRole is one WCIF role
// ("delegate") or several joined with "+" ("delegate+organizer"), which
// matches people who have all of them — that's how someone with more than
// one role gets a value of their own.

// Order used when listing roles and building combination names: the
// "most important" role first.
const ROLE_ORDER = ["delegate", "trainee-delegate", "organizer", "staff-dataentry", "staff-announcer", "staff-scrambler", "staff-runner", "staff-judge"];

function roleRank(role) {
  const i = ROLE_ORDER.indexOf(role);
  return i === -1 ? ROLE_ORDER.length : i;
}

function sortRoles(roles) {
  return [...roles].sort((a, b) => roleRank(a) - roleRank(b) || a.localeCompare(b));
}

// "organizer + delegate" -> ["delegate", "organizer"]
export function ruleRoles(wcaRole) {
  return sortRoles(
    (wcaRole || "")
      .split("+")
      .map((r) => r.trim())
      .filter(Boolean)
  );
}

function ruleKey(wcaRole) {
  return ruleRoles(wcaRole).join("+");
}

export function ruleMatches(rule, personRoles) {
  const needed = ruleRoles(rule.wcaRole);
  return needed.length > 0 && needed.every((r) => personRoles.includes(r));
}

export function personRole(person, mapping) {
  const roles = person.roles || [];
  for (const rule of mapping.rules || []) {
    if (ruleMatches(rule, roles)) return rule.label || rule.wcaRole;
  }
  return mapping.fallback || "competitor";
}

/**
 * Adds a rule for every role and every combination of roles that `persons`
 * actually have and the mapping doesn't cover yet (label = the role(s)
 * themselves, to rename as needed). Rules are then ordered most specific
 * first — combinations above single roles — so a combination is never
 * shadowed by one of its parts; rules of the same size keep their order.
 */
export function addRolesFromPersons(mapping, persons) {
  const existing = new Set((mapping.rules || []).map((r) => ruleKey(r.wcaRole)).filter(Boolean));
  const found = new Set();
  for (const p of persons) {
    const roles = sortRoles(new Set(p.roles || []));
    roles.forEach((r) => found.add(r));
    if (roles.length > 1) found.add(roles.join("+"));
  }
  const added = [...found]
    .filter((key) => !existing.has(key))
    .sort((a, b) => ruleRoles(b).length - ruleRoles(a).length || roleRank(ruleRoles(a)[0]) - roleRank(ruleRoles(b)[0]) || a.localeCompare(b))
    .map((key) => ({ wcaRole: key, label: key }));
  if (added.length === 0) return mapping;

  const rules = [...(mapping.rules || []), ...added]
    .map((rule, i) => ({ rule, i, size: ruleRoles(rule.wcaRole).length }))
    // Blank rules (size 0) stay at the end; otherwise bigger combinations first.
    .sort((a, b) => (a.size === 0) - (b.size === 0) || b.size - a.size || a.i - b.i)
    .map(({ rule }) => rule);
  return { ...mapping, rules };
}

// How many of `persons` each rule catches (first match wins), plus how
// many fall through to the fallback.
export function countByRule(mapping, persons) {
  const counts = (mapping.rules || []).map(() => 0);
  let fallback = 0;
  for (const p of persons) {
    const i = (mapping.rules || []).findIndex((rule) => ruleMatches(rule, p.roles || []));
    if (i === -1) fallback++;
    else counts[i]++;
  }
  return { counts, fallback };
}
