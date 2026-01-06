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

  // Fall 1: ISO-Datum (kommt oft von Vapi)
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateInput)) {
    candidate = new Date(dateInput + "T00:00:00");
  }
  // Fall 2: "5.1." oder "05.01"
  else {
    const match = dateInput.match(/^(\d{1,2})\.(\d{1,2})$/);
    if (!match) {
      throw new Error("Invalid date format: " + dateInput);
    }

    const day = Number(match[1]);
    const month = Number(match[2]) - 1;
    const currentYear = today.getFullYear();

    candidate = new Date(currentYear, month, day);
  }

  candidate.setHours(0, 0, 0, 0);

  // 🔥 DAS IST DER ENTSCHEIDENDE TEIL 🔥
  // Jahr so lange erhöhen, bis Datum in der Zukunft liegt
  while (candidate < today) {
    candidate.setFullYear(candidate.getFullYear() + 1);
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
   CANCEL RESERVATION
========================= */

app.post("/cancel-reservation", async (req, res) => {
  try {
    console.log("=== CANCEL RESERVATION START ===");
    console.log("RAW BODY:", req.body);

    const { date, time_text, name, phone } = req.body;

    if (!date || !time_text) {
      return res.status(400).json({ error: "date and time_text required" });
    }

    const normalizedDate = normalizeDateToNextFuture(date);

    // Airtable-Filter: passende bestätigte Reservierung suchen
    let formula = `AND(
      {status}="bestätigt",
      {date}="${normalizedDate}",
      {time_text}="${time_text}"
    )`;

    // Optional: Name oder Telefonnummer einschränken
    if (phone) {
      formula = `AND(${formula}, {phone}="${phone}")`;
    } else if (name) {
      formula = `AND(${formula}, {name}="${name}")`;
    }

    console.log("FILTER FORMULA:", formula);

    const search = await axios.get(
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

    if (search.data.records.length === 0) {
      return res.json({
        success: false,
        message: "Keine passende Reservierung gefunden",
      });
    }

    const recordId = search.data.records[0].id;

    // Status auf "storniert" setzen
    await axios.patch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE}/${recordId}`,
      {
        fields: {
          status: "storniert",
        },
      },
      {
        headers: {
          Authorization: `Bearer ${AIRTABLE_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("RESERVATION CANCELED:", recordId);

    res.json({
      success: true,
      message: "Reservierung wurde storniert",
    });
  } catch (err) {
    console.error("CANCEL ERROR:", err.response?.data || err.message);
    res.status(500).json({ error: "Server error" });
  }
});


/* =========================
   SERVER START
========================= */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server läuft auf Port ${PORT}`);
});
