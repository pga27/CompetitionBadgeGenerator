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

function buildBaseSchedule(wcif, timeZone = "UTC") {
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
  function shortened(name, code) {
    const eventId = code.split("-")[0];
    if (name.includes(",")) {
      const parts = name.split(", ");
      if (parts[0] === "3x3x3 Multi-Blind") {
        return `${ABV[parts[0]] || parts[0]} - ${parts[2][0]}${parts[2].split(" ")[1]}`;
      }

      const roundNum = parseInt(parts[1].split(" ")[1], 10);
      if (eventId !== "other" && roundNum === (roundAmounts[eventId] || 0)) {
        return `${SUBSEQUENT_ROUND_NAMES[parts[0]] || parts[0]} Final`;
      } else if (eventId !== "other" && roundNum > 1 && (groupAmounts[code] || 1) > 1) {
        return `${SUBSEQUENT_ROUND_NAMES[parts[0]] || parts[0]} ${parts[1][0]}${parts[1].split(" ")[1]}`;
      } else {
        return `${shortened(parts[0], code)} ${parts[1][0]}${parts[1].split(" ")[1]} - ${parts[2][0]}${parts[2].split(" ")[1]}`;
      }
    } else {
      return ABV[name] || name;
    }
  }

  // 1. Map rooms & index all activities (every room's activities, including
  // parallel stages hosting the same round).
  const roomsById = {};
  const activities = [];
  const seenActivityIds = new Set();

  for (const venue of wcif.schedule?.venues || []) {
    for (const room of venue.rooms || []) {
      roomsById[room.id] = {
        name: room.name || "",
        color: room.color || "#1E5FD9",
      };

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
              roomId: room.id,
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
              roomId: room.id,
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
    const key = `${activity.activityCode || `noCode_${activity.id}`}_${activity.startTime}`;

    // Round > 1 of an event that has more than one round at all — these are
    // the rows where a badge can't print a fixed task, since who's assigned
    // where in round 2+ isn't known at print time. eventId/roundNum parsed
    // straight from the WCA activityCode format, e.g. "333-r2" -> event
    // "333", round 2.
    const [codeEventId, codeRoundPart] = (activity.activityCode || "").split("-");
    const codeRoundNum = codeRoundPart && codeRoundPart.startsWith("r") ? parseInt(codeRoundPart.slice(1), 10) : null;
    const isSubsequentRound = codeEventId && codeEventId !== "other" && (roundAmounts[codeEventId] || 1) > 1 && codeRoundNum > 1;

    if (!roundsByDay[day]) roundsByDay[day] = new Map();
    const bucket = roundsByDay[day];

    if (!bucket.has(key)) {
      bucket.set(key, {
        time: startTime,
        event: shortened(activity.name, activity.activityCode),
        activity_ids: [activity.id],
        parent_ids: [activity.parentId],
        room_ids: [activity.roomId],
        activityCode: activity.activityCode,
        isSubsequentRound,
        sort_key: sortKey,
      });
    } else {
      const row = bucket.get(key);
      row.activity_ids.push(activity.id);
      row.parent_ids.push(activity.parentId);
      row.room_ids.push(activity.roomId);
    }
  }

  const baseSchedule = {};
  for (const [day, bucket] of Object.entries(roundsByDay)) {
    baseSchedule[day] = Array.from(bucket.values()).sort((a, b) => a.sort_key - b.sort_key);
  }

  return { baseSchedule, roomsById };
}

/**
 * Per-competitor schedules, with real assignment data. One row per round
 * (collapsed across parallel stages) per day; if the person is assigned to
 * ANY of that round's stage-variants, the row's task + color reflect that
 * specific stage — color is how you tell stages apart, per row. This is
 * what batch generation uses to fill each individual badge.
 */
export function buildCompetitorSchedules(wcif, timezoneOverride) {
  const timeZone = resolveScheduleTimezone(wcif, timezoneOverride);
  const { baseSchedule, roomsById } = buildBaseSchedule(wcif, timeZone);

  const competitorSchedules = {};

  for (const person of wcif.persons || []) {
    const regId = String(person.registrantId) || String(person.wcaId);

    const assignmentsById = {};
    for (const a of person.assignments || []) {
      assignmentsById[a.activityId] = a;
    }

    const personDays = {};

    for (const [day, rounds] of Object.entries(baseSchedule)) {
      personDays[day] = rounds.map((round) => {
        const isSpecial = (round.activityCode || "").startsWith("other");
        let task = null;
        let color = null;

        if (!isSpecial) {
          for (let i = 0; i < round.activity_ids.length; i++) {
            const assigned = assignmentsById[round.activity_ids[i]] || (round.parent_ids[i] && assignmentsById[round.parent_ids[i]]);
            if (assigned) {
              const rawCode = assigned.assignmentCode || "";
              task = TASK_DISPLAY[rawCode] || rawCode.replace(/^staff-/, "").charAt(0).toUpperCase();
              color = roomsById[round.room_ids[i]]?.color || "#1E5FD9";
              break;
            }
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
 * (C/J/S/R) purely to demonstrate how task labels will look. Color is
 * intentionally omitted entirely: which stage applies is only meaningful
 * once a specific person is known, which only happens during batch
 * generation (see buildCompetitorSchedules above).
 */
export function buildGenericSchedule(wcif, timezoneOverride) {
  const timeZone = resolveScheduleTimezone(wcif, timezoneOverride);
  const { baseSchedule } = buildBaseSchedule(wcif, timeZone);

  const genericSchedule = {};
  let counter = 0;

  for (const [day, rounds] of Object.entries(baseSchedule)) {
    genericSchedule[day] = rounds.map((round) => {
      const isSpecial = (round.activityCode || "").startsWith("other");
      let task = null;
      if (!isSpecial) {
        if (round.isSubsequentRound) {
          // Round 2+ assignments genuinely aren't known before the
          // competition for ANY competitor — so "QR" isn't a placeholder
          // standing in for real data, it's the actual real answer.
          // Doesn't consume a slot in the placeholder rotation below.
          task = "QR";
        } else {
          task = PLACEHOLDER_TASKS[counter % PLACEHOLDER_TASKS.length];
          counter++;
        }
      }
      return {
        id: String(round.activity_ids[0]),
        time: round.time,
        event: round.event,
        task,
        color: null, // generic preview never implies a specific stage
        isSpecial,
        isSubsequentRound: !!round.isSubsequentRound,
        activityCode: round.activityCode,
      };
    });
  }

  return genericSchedule;
}

/**
 * Flat list of every stage/room in the competition, deduplicated, in the
 * order they first appear. Used to build the "stage color key" — a legend
 * mapping each stage's name to the color it's shown in throughout the
 * schedule field.
 */
export function buildStageList(wcif) {
  const stages = [];
  const seen = new Set();
  for (const venue of wcif.schedule?.venues || []) {
    for (const room of venue.rooms || []) {
      if (seen.has(room.id)) continue;
      seen.add(room.id);
      stages.push({ name: room.name || `Stage ${stages.length + 1}`, color: room.color || "#1E5FD9" });
    }
  }
  return stages;
}