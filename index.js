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

  // Fall 1: ISO-Datum kommt von Vapi (YYYY-MM-DD)
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateInput)) {
    const d = new Date(dateInput + "T00:00:00");
    if (d < today) {
      d.setFullYear(d.getFullYear() + 1);
    }
    return d.toISOString().slice(0, 10);
  }

  // Fall 2: Format wie "5.1." oder "05.01"
  const match = dateInput.match(/^(\d{1,2})\.(\d{1,2})$/);
  if (!match) {
    throw new Error("Invalid date format");
  }

  const day = Number(match[1]);
  const month = Number(match[2]) - 1;

  let year = today.getFullYear();
  let candidate = new Date(year, month, day);
  candidate.setHours(0, 0, 0, 0);

  // Wenn Datum dieses Jahr schon vorbei → nächstes Jahr
  if (candidate < today) {
    candidate = new Date(year + 1, month, day);
  }

  return candidate.toISOString().slice(0, 10);
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
  console.log("=== CREATE RESERVATION START ===");
  console.log("RAW BODY:", req.body);

  try {
    let { date, time_text, guests, name = "", phone = "" } = req.body;
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

    const payload = {
      fields: {
        date: normalizedDate,
        time_text,
        guests,
        name,
        phone,
        status: "bestätigt",
        start_datetime: start.toISOString(),
        end_datetime: end.toISOString(),
      },
    };

    console.log("AIRTABLE PAYLOAD:", payload);

    const response = await axios.post(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE}`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${AIRTABLE_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("AIRTABLE RECORD ID:", response.data.id);

    return res.json({
      success: true,
      recordId: response.data.id,
    });

  } catch (err) {
    console.error("CREATE RESERVATION ERROR", err.response?.data || err.message);
    return res.status(500).json({ error: "Could not create reservation" });
  }
});

/* =========================
   SERVER START
========================= */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server läuft auf Port ${PORT}`);
});
