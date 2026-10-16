const ABV = {
  "3x3x3 Multi-Blind": "3x3 MBLD",
  "5x5x5 Blindfolded": "5BLD",
  "4x4x4 Blindfolded": "4BLD",
  "3x3x3 Cube": "3x3x3",
  "2x2x2 Cube": "2x2x2",
  "4x4x4 Cube": "4x4x4",
  "5x5x5 Cube": "5x5x5",
  "6x6x6 Cube": "6x6",
  "7x7x7 Cube": "7x7",
  "3x3x3 One-Handed": "3x3 OH",
  "3x3x3 Fewest Moves": "3x3 FM",
  "3x3x3 Blindfolded": "3x3 BLD",
  "Pyraminx": "Pyra",
  "Megaminx": "Mega",
  "Square-1": "Sq-1",
  "Skewb": "Skewb",
  "Clock": "Clock",
  "Cube submission for 3x3x3 Multi-Blind": "Submit MBLD",
  "Tutorial for new competitors": "Tutorial",
};

const SUBSEQUENT_ROUND_NAMES = {
  "3x3x3 Multi-Blind": "3x3 MBLD",
  "5x5x5 Blindfolded": "5BLD",
  "4x4x4 Blindfolded": "4BLD",
  "3x3x3 Cube": "3x3x3",
  "2x2x2 Cube": "2x2x2",
  "4x4x4 Cube": "4x4x4",
  "5x5x5 Cube": "5x5x5",
  "6x6x6 Cube": "6x6x6",
  "7x7x7 Cube": "7x7x7",
  "3x3x3 One-Handed": "3x3 OH",
  "3x3x3 Fewest Moves": "3x3 FM",
  "3x3x3 Blindfolded": "3x3 BLD",
  "Pyraminx": "Pyraminx",
  "Megaminx": "Megaminx",
  "Square-1": "Square-1",
  "Skewb": "Skewb",
  "Clock": "Clock",
};

const TASK_DISPLAY = {
  "competitor": "C",
  "staff-judge": "J",
  "staff-judges": "J",
  "staff-scramble": "S",
  "staff-runner": "R",
  "staff-delegate": "D",
  "staff-delegates": "D",
  "staff-dataentry": "E",
  "staff-TableManager": "T",
};

const PLACEHOLDER_TASKS = ["C", "J", "S", "R"];

const DEFAULT_COLOR = "#1E5FD9";

// Stages (several timing areas inside one physical room) aren't part of the
// core WCIF spec — they come from CubingUSA's natshelper extension: the Room
// lists its stages, and each group activity names the stage it runs on.
// Matched on prefix/suffix so a future "v2" of the extension still works.
// https://github.com/cubingusa/natshelper/blob/main/specification.md
function findNatshelperExtension(obj, kind) {
  return (obj?.extensions || []).find(
    (e) => typeof e.id === "string" && e.id.startsWith("org.cubingusa.natshelper.") && e.id.endsWith(`.${kind}`)
  );
}

function roomStages(room) {
  return findNatshelperExtension(room, "Room")?.data?.stages || [];
}

function activityStageId(activity) {
  return findNatshelperExtension(activity, "Group")?.data?.stageId ?? null;
}

// Color an activity is shown in: its stage's color when the room is split
// into stages, otherwise the room's own color (pre-stages WCIFs). A user
// override for that stage name (stageColors, e.g. a softer print-friendly
// tone than the one set on the WCA website) wins over both.
function activityColor(activity, room, stagesById, stageColors) {
  const stage = stagesById[activityStageId(activity)];
  const name = stage ? stage.name : room.name;
  return stageColors[name] || stage?.color || room.color || DEFAULT_COLOR;
}

/**
 * Resolves which IANA/Olson timezone to display schedule times in.
 * An explicit override always wins; otherwise this falls back to the
 * first venue's `timezone` in the WCIF. That field is part of the WCIF
 * spec precisely for this purpose (an Olson/IANA zone name, e.g.
 * "Europe/Lisbon") and — unlike a fixed UTC-hour offset someone has to
 * remember to update — correctly reflects whether DST is in effect for
 * the competition's actual dates, automatically, every year. Falls back
 * to "UTC" (the previous behavior) if neither is available.
 */
export function resolveScheduleTimezone(wcif, override) {
  if (override) return override;
  for (const venue of wcif?.schedule?.venues || []) {
    if (venue.timezone) return venue.timezone;
  }
  return "UTC";
}

// Splits an ISO 8601 UTC instant into the wall-clock date + time it falls
// on in `timeZone`, via Intl's own IANA timezone database — this is what
// actually gets DST right (Intl knows the real transition dates for the
// zone, rather than this code having to hardcode "+1 in summer" and hope
// nobody forgets to update it).
function formatInTimezone(isoUtcString, timeZone) {
  const date = new Date(isoUtcString);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return { day: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
}

// Default label for a non-event ("other-…") activity. MBLD cube
// submissions are often suffixed with the attempt they're for
// ("Cube submission for 3x3x3 Multi-Blind A1"), which would otherwise miss
// the ABV entry and print the whole long name.
function defaultActivityLabel(name, code) {
  if (code === "other-multi") {
    const attempt = mbldSubmissionAttempt(name);
    return attempt ? `Submit MBLD A${attempt}` : "Submit MBLD";
  }
  return ABV[name] || name;
}

// "…Multi-Blind A2" -> 2; null when the submission isn't tied to an attempt.
function mbldSubmissionAttempt(name) {
  const m = /\bA(\d+)\s*$/.exec(name || "");
  return m ? parseInt(m[1], 10) : null;
}

// Event part of an activity name, in either naming style:
// "3x3x3 Cube, Round 1, Group 2" / "3x3x3 Cube Round 1 Green 2" -> "3x3x3 Cube".
function eventNameOf(activityName) {
  return (activityName || "").split(", ")[0].split(" Round ")[0];
}

/**
 * Every text the schedule table derives from the WCIF that the user can
 * rename (see the Schedule panel in BadgeDesigner.jsx): one entry per event
 * (overriding the event part of all its rows, e.g. "3x3 OH" -> "OH") and one
 * per distinct non-event activity name (e.g. "Lunch" -> "Comida"). Also
 * lists the later rounds (round 2+ of multi-round events) whose groups can
 * be merged into one row (see mergedRounds in buildBaseSchedule), with how
 * many groups each has.
 */
export function listScheduleTexts(wcif) {
  const events = new Map();
  const eventNames = {};
  const activities = new Map();
  const groupsByRound = {};
  for (const venue of wcif?.schedule?.venues || []) {
    for (const room of venue.rooms || []) {
      for (const act of room.activities || []) {
        const leaves = act.childActivities && act.childActivities.length > 0 ? act.childActivities : [act];
        for (const a of [act, ...leaves]) {
          const code = a.activityCode || "";
          const eventId = code.split("-")[0];
          if (eventId === "other") {
            if (!activities.has(a.name)) activities.set(a.name, { name: a.name, defaultText: defaultActivityLabel(a.name, code) });
          } else if (eventId && !events.has(eventId)) {
            const eventName = eventNameOf(a.name);
            eventNames[eventId] = eventName;
            events.set(eventId, { id: eventId, defaultText: ABV[eventName] || eventName });
          }
          const group = /^([^-]+-r\d+)-g\d+/.exec(code);
          if (group) (groupsByRound[group[1]] ||= new Set()).add(code.replace(/-a\d+$/, ""));
        }
      }
    }
  }

  const laterRounds = [];
  for (const event of wcif?.events || []) {
    const rounds = event.rounds || [];
    const eventName = eventNames[event.id] || event.id;
    rounds.slice(1).forEach((round, i) => {
      const roundNum = i + 2;
      const label = `${SUBSEQUENT_ROUND_NAMES[eventName] || eventName} ${roundNum === rounds.length ? "Final" : `R${roundNum}`}`;
      laterRounds.push({ code: round.id, label, groups: groupsByRound[round.id]?.size || 0 });
    });
  }

  return { events: [...events.values()], activities: [...activities.values()], laterRounds };
}

/**
 * Options shared by the schedule builders below, all optional:
 * - stageColors: { [stageName]: hex } print colors replacing the WCA ones.
 * - labels: { events: { [eventId]: text }, activities: { [activityName]: text } }
 *   user renames, see listScheduleTexts.
 * - mbldSubmission: { enabled, task, hideForOthers } — show the MBLD cube
 *   submission as a task for the people competing in MBLD (see
 *   buildCompetitorSchedules).
 * - mergedRounds: round codes (e.g. ["333-r4"]) shown as one row instead
 *   of one per group. Only applies to round 2+/finals — safe there because
 *   those rows print "QR" anyway, since who's in which group isn't known
 *   when badges are printed.
 */
function buildBaseSchedule(wcif, timeZone = "UTC", { stageColors = {}, labels = {}, mergedRounds = [] } = {}) {
  const mergedRoundCodes = new Set(mergedRounds);
  const eventLabels = labels.events || {};
  const activityLabels = labels.activities || {};
  const roundAmounts = {};
  for (const event of wcif.events || []) {
    roundAmounts[event.id] = (event.rounds || []).length;
  }

  const groupAmounts = {};
  for (const event of wcif.events || []) {
    for (const roundObj of event.rounds || []) {
      const ext = roundObj.extensions || [];
      if (ext[0]?.data?.groups) {
        groupAmounts[roundObj.id] = ext[0].data.groups;
      }
    }
  }

  // Restored exactly as originally written: Final rounds (single group) get
  // "Event Final"; other single-group rounds get "Event R{n}"; multi-group
  // rounds get "Event R{n} - G{m}".
  // The event part of a label: the user's rename for this event if any,
  // otherwise the built-in abbreviation from `table` (ABV for round-1 rows,
  // SUBSEQUENT_ROUND_NAMES for finals/later rounds).
  function eventText(eventId, eventName, table) {
    return eventLabels[eventId] || table[eventName] || eventName;
  }

  function shortened(name, code) {
    const eventId = code.split("-")[0];
    if (name.includes(",")) {
      const parts = name.split(", ");
      if (parts[0] === "3x3x3 Multi-Blind") {
        return `${eventText(eventId, parts[0], ABV)} - ${parts[2][0]}${parts[2].split(" ")[1]}`;
      }

      const roundNum = parseInt(parts[1].split(" ")[1], 10);
      if (eventId !== "other" && roundNum === (roundAmounts[eventId] || 0)) {
        return `${eventText(eventId, parts[0], SUBSEQUENT_ROUND_NAMES)} Final`;
      } else if (eventId !== "other" && roundNum > 1 && (groupAmounts[code] || 1) > 1) {
        return `${eventText(eventId, parts[0], SUBSEQUENT_ROUND_NAMES)} ${parts[1][0]}${parts[1].split(" ")[1]}`;
      } else {
        return `${eventText(eventId, parts[0], ABV)} ${parts[1][0]}${parts[1].split(" ")[1]} - ${parts[2][0]}${parts[2].split(" ")[1]}`;
      }
    } else if (/^[^-]+-r\d+/.test(code || "") && name.includes(" Round ")) {
      return shortenedFromCode(name, code);
    } else if (eventId === "other") {
      return activityLabels[name] || defaultActivityLabel(name, code);
    } else {
      return eventText(eventId, name, ABV);
    }
  }

  // Newer names drop the commas and, in stage-split rooms, use the stage
  // name instead of "Group" ("3x3x3 Cube Round 1 Green 3"). The name is only
  // trusted for the event part; round/group/attempt come from the
  // activityCode, and the stage itself is conveyed by the row's color.
  function shortenedFromCode(name, code) {
    const eventName = name.split(" Round ")[0];
    const eventId = code.split("-")[0];
    const roundNum = parseInt(code.match(/-r(\d+)/)[1], 10);
    const groupNum = code.match(/-g(\d+)/)?.[1];
    const attemptNum = code.match(/-a(\d+)/)?.[1];
    const abbreviated = eventText(eventId, eventName, ABV);
    const subsequent = eventText(eventId, eventName, SUBSEQUENT_ROUND_NAMES);

    if (attemptNum) {
      return `${abbreviated} - A${attemptNum}`;
    } else if (roundNum === (roundAmounts[eventId] || 0)) {
      return `${subsequent} Final`;
    } else if (roundNum > 1 && (groupAmounts[code] || 1) > 1) {
      return `${subsequent} R${roundNum}`;
    } else if (groupNum) {
      return `${abbreviated} R${roundNum} - G${groupNum}`;
    } else {
      return `${abbreviated} R${roundNum}`;
    }
  }

  // 1. Index all activities (every room's activities, including parallel
  // stages hosting the same round), each tagged with the color of the
  // stage — or, without stages, the room — it happens in.
  const activities = [];
  const seenActivityIds = new Set();

  for (const venue of wcif.schedule?.venues || []) {
    for (const room of venue.rooms || []) {
      const stagesById = {};
      for (const stage of roomStages(room)) stagesById[stage.id] = stage;

      for (const act of room.activities || []) {
        if (!act.childActivities || act.childActivities.length === 0) {
          if (!seenActivityIds.has(act.id)) {
            seenActivityIds.add(act.id);
            activities.push({
              id: act.id,
              parentId: null,
              name: act.name,
              startTime: act.startTime,
              activityCode: act.activityCode,
              color: activityColor(act, room, stagesById, stageColors),
            });
          }
        }

        for (const child of act.childActivities || []) {
          if (!seenActivityIds.has(child.id)) {
            seenActivityIds.add(child.id);
            activities.push({
              id: child.id,
              parentId: act.id,
              name: child.name,
              startTime: child.startTime,
              activityCode: child.activityCode,
              color: activityColor(child, room, stagesById, stageColors),
            });
          }
        }
      }
    }
  }

  // 2. Collapse across rooms/stages: activities sharing the same day +
  // activityCode + exact start time are the SAME conceptual slot (one
  // group of a round split across parallel stages happening simultaneously),
  // so they become a single row. Different groups of the same round running
  // at different times stay as separate rows, each keeping its own
  // "- G{n}" / "Final" label from shortened() above.
  const roundsByDay = {};

  for (const activity of activities) {
    if (!activity.startTime) continue;

    // Convert the activity's absolute UTC instant to the wall-clock
    // date+time it falls on in `timeZone` (see formatInTimezone above —
    // this is what makes the displayed times follow DST correctly). An
    // invalid/unrecognized zone name (Intl throws a RangeError for those)
    // falls back to the raw UTC digits rather than silently dropping the
    // row, so a typo in a manual override degrades gracefully instead of
    // breaking the whole schedule.
    let day, startTime;
    try {
      const formatted = formatInTimezone(activity.startTime, timeZone);
      day = formatted.day;
      startTime = formatted.time;
    } catch (e) {
      const [datePart, timePart] = activity.startTime.split("T");
      day = datePart;
      startTime = timePart.slice(0, 5);
    }
    const sortKey = new Date(activity.startTime).getTime();

    // Round > 1 of an event that has more than one round at all — these are
    // the rows where a badge can't print a fixed task, since who's assigned
    // where in round 2+ isn't known at print time. eventId/roundNum parsed
    // straight from the WCA activityCode format, e.g. "333-r2" -> event
    // "333", round 2.
    const [codeEventId, codeRoundPart] = (activity.activityCode || "").split("-");
    const codeRoundNum = codeRoundPart && codeRoundPart.startsWith("r") ? parseInt(codeRoundPart.slice(1), 10) : null;
    const isSubsequentRound = codeEventId && codeEventId !== "other" && (roundAmounts[codeEventId] || 1) > 1 && codeRoundNum > 1;

    // Merged later rounds share one key per round and day, and are labelled
    // as the round ("3x3x3 Final", "3x3x3 R2") rather than one of its groups.
    const roundCode = `${codeEventId}-${codeRoundPart}`;
    const mergeIntoRound = isSubsequentRound && mergedRoundCodes.has(roundCode);
    const key = mergeIntoRound ? `${roundCode}_${day}` : `${activity.activityCode || `noCode_${activity.id}`}_${activity.startTime}`;
    const label = mergeIntoRound
      ? shortenedFromCode(`${eventNameOf(activity.name)} Round ${codeRoundNum}`, roundCode)
      : shortened(activity.name, activity.activityCode);

    if (!roundsByDay[day]) roundsByDay[day] = new Map();
    const bucket = roundsByDay[day];

    if (bucket.has(key) && mergeIntoRound && sortKey < bucket.get(key).sort_key) {
      // A merged round starts with its earliest group.
      Object.assign(bucket.get(key), { time: startTime, sort_key: sortKey });
    }

    if (!bucket.has(key)) {
      bucket.set(key, {
        time: startTime,
        event: label,
        activity_ids: [activity.id],
        parent_ids: [activity.parentId],
        colors: [activity.color],
        activityCode: activity.activityCode,
        mbldAttempt: activity.activityCode === "other-multi" ? mbldSubmissionAttempt(activity.name) : null,
        isSubsequentRound,
        sort_key: sortKey,
      });
    } else {
      const row = bucket.get(key);
      row.activity_ids.push(activity.id);
      row.parent_ids.push(activity.parentId);
      row.colors.push(activity.color);
    }
  }

  const baseSchedule = {};
  for (const [day, bucket] of Object.entries(roundsByDay)) {
    baseSchedule[day] = Array.from(bucket.values()).sort((a, b) => a.sort_key - b.sort_key);
  }

  return { baseSchedule };
}

// Attempt number of every MBLD activity (rounds, groups, attempts), keyed
// by activity id: "333mbf-r1-g1-a2" -> 2, or 0 when the code names no
// attempt. Used to tell which submission(s) a competitor has to show up to.
function mbldAttemptsByActivityId(wcif) {
  const attempts = {};
  const visit = (act) => {
    if ((act.activityCode || "").startsWith("333mbf")) {
      attempts[act.id] = parseInt(act.activityCode.match(/-a(\d+)/)?.[1] || "0", 10);
    }
    (act.childActivities || []).forEach(visit);
  };
  for (const venue of wcif.schedule?.venues || []) {
    for (const room of venue.rooms || []) (room.activities || []).forEach(visit);
  }
  return attempts;
}

// Whether `person` has to hand in cubes at a submission for `attempt`
// (null = submission not tied to an attempt). Competitors aren't assigned
// to the submission itself, so this goes by their MBLD competitor
// assignments, or — before groups are made — by their registration.
function submitsMbldCubes(person, attempt, mbldAttempts) {
  const assigned = new Set();
  for (const a of person.assignments || []) {
    if (a.assignmentCode === "competitor" && a.activityId in mbldAttempts) assigned.add(mbldAttempts[a.activityId]);
  }
  if (assigned.size === 0) return (person.registration?.eventIds || []).includes("333mbf");
  return attempt == null || assigned.has(attempt) || assigned.has(0);
}

/**
 * Per-competitor schedules, with real assignment data. One row per round
 * (collapsed across parallel stages) per day; if the person is assigned to
 * ANY of that round's stage-variants, the row's task + color reflect that
 * specific stage — color is how you tell stages apart, per row. This is
 * what batch generation uses to fill each individual badge.
 *
 * With options.mbldSubmission.enabled, the MBLD cube submission rows turn
 * into regular task rows for everyone involved, and — with hideForOthers —
 * disappear from everyone else's schedule. Staff working the submission
 * are assigned to it directly and get their usual task letter; competitors
 * are only assigned to the MBLD attempt itself, so whoever competes in it
 * (see submitsMbldCubes) gets options.mbldSubmission.task.
 */
export function buildCompetitorSchedules(wcif, timezoneOverride, options = {}) {
  const timeZone = resolveScheduleTimezone(wcif, timezoneOverride);
  const { baseSchedule } = buildBaseSchedule(wcif, timeZone, options);
  const mbld = options.mbldSubmission || {};
  const mbldAttempts = mbld.enabled ? mbldAttemptsByActivityId(wcif) : {};

  const competitorSchedules = {};

  for (const person of wcif.persons || []) {
    const regId = String(person.registrantId) || String(person.wcaId);

    const assignmentsById = {};
    for (const a of person.assignments || []) {
      assignmentsById[a.activityId] = a;
    }

    const personDays = {};

    for (const [day, rounds] of Object.entries(baseSchedule)) {
      personDays[day] = rounds.flatMap((round) => {
        let isSpecial = (round.activityCode || "").startsWith("other");
        let task = null;
        let color = null;

        if (mbld.enabled && round.activityCode === "other-multi") {
          const i = round.activity_ids.findIndex((id, k) => assignmentsById[id] || (round.parent_ids[k] && assignmentsById[round.parent_ids[k]]));
          const assigned = i >= 0 ? assignmentsById[round.activity_ids[i]] || assignmentsById[round.parent_ids[i]] : null;
          if (assigned || submitsMbldCubes(person, round.mbldAttempt, mbldAttempts)) {
            const rawCode = assigned?.assignmentCode || "competitor";
            isSpecial = false;
            task = rawCode === "competitor" ? mbld.task || "C" : TASK_DISPLAY[rawCode] || rawCode.replace(/^staff-/, "").charAt(0).toUpperCase();
            color = round.colors[Math.max(i, 0)];
          } else if (mbld.hideForOthers) {
            return [];
          }
        } else if (!isSpecial) {
          for (let i = 0; i < round.activity_ids.length; i++) {
            const assigned = assignmentsById[round.activity_ids[i]] || (round.parent_ids[i] && assignmentsById[round.parent_ids[i]]);
            if (assigned) {
              const rawCode = assigned.assignmentCode || "";
              task = TASK_DISPLAY[rawCode] || rawCode.replace(/^staff-/, "").charAt(0).toUpperCase();
              color = round.colors[i];
              break;
            }
          }
        }

        return [
          {
            id: String(round.activity_ids[0]),
            time: round.time,
            event: round.event,
            task,
            color,
            isSpecial,
            isSubsequentRound: !!round.isSubsequentRound,
            activityCode: round.activityCode,
          },
        ];
      });
    }

    competitorSchedules[regId] = personDays;
  }

  return competitorSchedules;
}

/**
 * Generic, placeholder-only schedule for template DESIGN time.
 *
 * Shows the real event structure (dates, times, event names — collapsed
 * across parallel stages into one row per round) so the template genuinely
 * matches the competition's shape, but does NOT pull any specific person's
 * actual assignments — tasks cycle through a fixed placeholder pattern
 * (C/J/S/R) purely to demonstrate how task labels will look. Colors are
 * placeholders the same way: which stage applies is only known per person
 * (see buildCompetitorSchedules above), so each task row is tinted with one
 * of the stages that actually hosts it, rotating along with the tasks — so
 * the stage colors (and any print overrides) show up while designing.
 */
export function buildGenericSchedule(wcif, timezoneOverride, options = {}) {
  const timeZone = resolveScheduleTimezone(wcif, timezoneOverride);
  const { baseSchedule } = buildBaseSchedule(wcif, timeZone, options);
  const mbld = options.mbldSubmission || {};

  const genericSchedule = {};
  let counter = 0;

  for (const [day, rounds] of Object.entries(baseSchedule)) {
    genericSchedule[day] = rounds.map((round) => {
      let isSpecial = (round.activityCode || "").startsWith("other");
      let task = null;
      let color = null;
      if (mbld.enabled && round.activityCode === "other-multi") {
        // Previewed as it prints for an MBLD competitor.
        isSpecial = false;
        task = mbld.task || "C";
        color = round.colors[0];
      } else if (!isSpecial) {
        if (round.isSubsequentRound) {
          // Round 2+ assignments genuinely aren't known before the
          // competition for ANY competitor — so "QR" isn't a placeholder
          // standing in for real data, it's the actual real answer.
          // Doesn't consume a slot in the placeholder rotation below, and
          // stays untinted, as it prints.
          task = "QR";
        } else {
          task = PLACEHOLDER_TASKS[counter % PLACEHOLDER_TASKS.length];
          color = round.colors[counter % round.colors.length];
          counter++;
        }
      }
      return {
        id: String(round.activity_ids[0]),
        time: round.time,
        event: round.event,
        task,
        color,
        isSpecial,
        isSubsequentRound: !!round.isSubsequentRound,
        activityCode: round.activityCode,
      };
    });
  }

  return genericSchedule;
}

/**
 * Flat list of every stage in the competition, deduplicated, in the order
 * they first appear. Used to build the "stage color key" — a legend mapping
 * each stage's name to the color it's shown in throughout the schedule
 * field. A room split into natshelper stages contributes its stages; a room
 * without them counts as a single stage itself (as in pre-stages WCIFs).
 * `color` is what gets printed (the user's override from stageColors, if
 * any); `wcaColor` is the one set on the WCA website, kept for resetting.
 */
export function buildStageList(wcif, stageColors = {}) {
  const stages = [];
  const seen = new Set();
  const push = (key, rawName, wcaColor) => {
    if (seen.has(key)) return;
    seen.add(key);
    stages.push({ name: rawName || `Stage ${stages.length + 1}`, color: stageColors[rawName] || wcaColor, wcaColor });
  };
  for (const venue of wcif.schedule?.venues || []) {
    for (const room of venue.rooms || []) {
      const subStages = roomStages(room);
      if (subStages.length > 0) {
        for (const stage of subStages) push(`stage-${stage.id}`, stage.name, stage.color || room.color || DEFAULT_COLOR);
      } else {
        push(`room-${room.id}`, room.name, room.color || DEFAULT_COLOR);
      }
    }
  }
  return stages;
}