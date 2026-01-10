import express from "express";
import axios from "axios";
import cors from "cors";
import "dotenv/config";

const app = express();
app.use(cors());
app.use(express.json());

/* =========================
   KONFIGURATION
========================= */

const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE = "Reservations";
const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;

const MAX_CAPACITY = 10;
const SLOT_DURATION_MS = 2 * 60 * 60 * 1000;

/* =========================
   HILFSFUNKTIONEN
========================= */

// 🔑 Datum immer in die Zukunft schieben (5.1. → 2026-01-05)
function normalizeDateToNextFuture(dateInput) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let candidate;

  // 🔹 relative Tage
  if (dateInput === "today") {
    candidate = new Date(today);
  }
  else if (dateInput === "tomorrow") {
    candidate = new Date(today);
    candidate.setDate(candidate.getDate() + 1);
  }
  else if (dateInput === "day_after_tomorrow") {
    candidate = new Date(today);
    candidate.setDate(candidate.getDate() + 2);
  }

  // 🔹 Wochentage
  else if (
    ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"]
      .includes(dateInput)
  ) {
    const weekdayMap = {
      sunday: 0,
      monday: 1,
      tuesday: 2,
      wednesday: 3,
      thursday: 4,
      friday: 5,
      saturday: 6,
    };

    const targetDay = weekdayMap[dateInput];
    candidate = new Date(today);

    const diff =
      (targetDay + 7 - candidate.getDay()) % 7 || 7;

    candidate.setDate(candidate.getDate() + diff);
  }

  // 🔹 ISO-Datum (YYYY-MM-DD)
  else if (/^\d{4}-\d{2}-\d{2}$/.test(dateInput)) {
    candidate = new Date(dateInput + "T00:00:00");
  }

  // 🔹 Formate wie 5.1. oder 05.01
  else {
    const match = dateInput.match(/^(\d{1,2})\.(\d{1,2})\.?$/);
    if (!match) {
      throw new Error("Invalid date format: " + dateInput);
    }

    const day = Number(match[1]);
    const month = Number(match[2]) - 1;

    candidate = new Date(today.getFullYear(), month, day);
  }

  candidate.setHours(0, 0, 0, 0);

  // 🔥 immer nächstes zukünftiges Datum
  while (candidate < today) {
    candidate.setFullYear(candidate.getFullYear() + 1);
  }

  return candidate.toISOString().slice(0, 10);
}




function normalizeDate(dateInput) {
  // Erwartet z. B. "2026-01-15" oder "15.01."
  if (!dateInput) throw new Error("date missing");

  // ISO-Format -> direkt zurück
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateInput)) {
    return dateInput;
  }

  // Format: 15.01. oder 15.1.
  const match = dateInput.match(/^(\d{1,2})\.(\d{1,2})\.?$/);
  if (!match) {
    throw new Error("invalid date format");
  }

  const day = parseInt(match[1], 10);
  const month = parseInt(match[2], 10) - 1;

  const now = new Date();
  let year = now.getFullYear();

  const candidate = new Date(year, month, day);
  if (candidate < now) {
    year += 1; // nächstes Jahr nehmen
  }

  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}




// 🕒 Start / Ende berechnen
function buildStartEnd(dateISO, timeText) {
  const start = new Date(`${dateISO}T${timeText}:00`);
  const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);
  return { start, end };
}


/* =========================
   HEALTH CHECK
========================= */

app.get("/", (req, res) => {
  res.json({ status: "ok" });
});

/* =========================
   CHECK AVAILABILITY
========================= */

app.post("/check-availability", async (req, res) => {
  console.log("=== CHECK AVAILABILITY START ===");
  console.log("RAW BODY:", req.body);

  try {
    let { date, time_text, guests } = req.body;
    guests = Number(guests);

    if (!date || !time_text || !guests) {
      return res.status(400).json({ error: "Missing parameters" });
    }

    const normalizedDate = normalizeDateToNextFuture(date);
    if (!normalizedDate) {
      return res.status(400).json({ error: "Invalid date format" });
    }

    const { start, end } = buildStartEnd(normalizedDate, time_text);

    console.log("NORMALIZED DATE:", normalizedDate);
    console.log("START:", start.toISOString());
    console.log("END:", end.toISOString());

    // 🔥 Überlappung korrekt
    const formula = `
AND(
  {status}="bestätigt",
  {start_datetime} < DATETIME_PARSE("${end.toISOString()}"),
  {end_datetime} > DATETIME_PARSE("${start.toISOString()}")
)
`;

    const response = await axios.get(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE}`,
      {
        headers: {
          Authorization: `Bearer ${AIRTABLE_TOKEN}`,
        },
        params: {
          filterByFormula: formula,
        },
      }
    );

    const overlappingGuests = response.data.records.reduce(
      (sum, r) => sum + (r.fields.guests || 0),
      0
    );

    const available = overlappingGuests + guests <= MAX_CAPACITY;

    console.log("OVERLAPPING GUESTS:", overlappingGuests);
    console.log("REQUESTED:", guests);
    console.log("AVAILABLE:", available);

    return res.json({
      available,
      overlappingGuests,
      remainingSeats: MAX_CAPACITY - overlappingGuests,
    });

  } catch (err) {
    console.error("CHECK AVAILABILITY ERROR", err.response?.data || err.message);
    return res.status(500).json({ error: "Server error" });
  }
});

/* =========================
   CREATE RESERVATION
========================= */

app.post("/create-reservation", async (req, res) => {
  try {
    console.log("=== CREATE RESERVATION START ===");
    console.log("RAW BODY:", req.body);

    const { date, time_text, guests, name = "" } = req.body;

    if (!date || !time_text || !guests) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const phone =
      req.body?.phone ||
      req.body?.caller?.phone?.number ||
      req.body?.call?.from ||
      "";

    const normalizedDate = normalizeDate(date);
    console.log("NORMALIZED DATE:", normalizedDate);

    const start = new Date(`${normalizedDate}T${time_text}:00`);
    const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);

    console.log("START:", start.toISOString());
    console.log("END:", end.toISOString());

    const airtablePayload = {
      fields: {
        date: normalizedDate,
        time_text,
        guests,
        name,
        phone,
        status: "bestätigt"
        // ⚠️ start_datetime / end_datetime NICHT setzen (computed fields!)
      }
    };

    console.log("AIRTABLE PAYLOAD:", airtablePayload);

    const response = await axios.post(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE}`,
      airtablePayload,
      {
        headers: {
          Authorization: `Bearer ${AIRTABLE_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log("AIRTABLE RECORD ID:", response.data.id);

    res.json({
      success: true,
      recordId: response.data.id
    });

  } catch (error) {
    console.error("CREATE RESERVATION ERROR", error.response?.data || error.message);
    res.status(500).json({ error: "Could not create reservation" });
  }
});


/* =========================
   CANCEL RESERVATION
========================= */

app.post("/cancel-reservation", async (req, res) => {
  try {
    console.log("=== CANCEL RESERVATION START ===");
    console.log("RAW BODY:", req.body);

    const { date, time_text, name = "" } = req.body;

    if (!date || !time_text) {
      return res.status(400).json({ error: "Missing date or time" });
    }

    const phone =
      req.body?.phone ||
      req.body?.caller?.phone?.number ||
      req.body?.call?.from ||
      "";

    const normalizedDate = normalizeDate(date);
    console.log("NORMALIZED DATE:", normalizedDate);

    const filterFormulaParts = [
      `{status}="bestätigt"`,
      `{date}="${normalizedDate}"`,
      `{time_text}="${time_text}"`
    ];

    if (phone) {
      filterFormulaParts.push(`{phone}="${phone}"`);
    }

    if (name) {
      filterFormulaParts.push(`{name}="${name}"`);
    }

    const filterFormula = `AND(${filterFormulaParts.join(",")})`;
    console.log("FILTER FORMULA:", filterFormula);

    const searchResponse = await axios.get(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE}`,
      {
        headers: {
          Authorization: `Bearer ${AIRTABLE_TOKEN}`
        },
        params: {
          filterByFormula: filterFormula
        }
      }
    );

    if (searchResponse.data.records.length === 0) {
      return res.json({
        success: false,
        message: "Keine passende Reservierung gefunden"
      });
    }

    const recordId = searchResponse.data.records[0].id;

    await axios.patch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE}/${recordId}`,
      {
        fields: {
          status: "storniert"
        }
      },
      {
        headers: {
          Authorization: `Bearer ${AIRTABLE_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    res.json({
      success: true,
      message: "Reservierung wurde storniert"
    });

  } catch (error) {
    console.error("CANCEL RESERVATION ERROR", error.response?.data || error.message);
    res.status(500).json({ error: "Could not cancel reservation" });
  }
});




/* =========================
   SERVER START
========================= */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server läuft auf Port ${PORT}`);
});
