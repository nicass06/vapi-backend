import express from "express";
import axios from "axios";
import cors from "cors";
import "dotenv/config";

const app = express();
app.use(cors());
app.use(express.json());

// ======================
// ENV / KONFIG
// ======================
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE = "Reservations";
const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;

const MAX_CAPACITY = 10;        // maximale Plätze
const SLOT_DURATION_HOURS = 2;  // Sitzdauer

// ======================
// HILFSFUNKTIONEN
// ======================

// Datum ohne Jahr → nächstes sinnvolles Datum
function normalizeDateToFuture(dateStr) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let target = new Date(dateStr);
  target.setHours(0, 0, 0, 0);

  // Jahr auf aktuelles Jahr setzen
  target.setFullYear(today.getFullYear());

  // Wenn Datum vorbei → nächstes Jahr
  if (target < today) {
    target.setFullYear(today.getFullYear() + 1);
  }

  return target.toISOString().slice(0, 10);
}

// ISO-Start / Ende berechnen
function buildStartEnd(dateISO, timeText) {
  const start = new Date(`${dateISO}T${timeText}:00.000Z`);
  const end = new Date(start.getTime() + SLOT_DURATION_HOURS * 60 * 60 * 1000 - 1);
  return { start, end };
}

// ======================
// CHECK AVAILABILITY
// ======================
app.post("/check-availability", async (req, res) => {
  console.log("=== CHECK AVAILABILITY START ===");
  console.log("RAW BODY:", req.body);

  try {
    const { date, time_text, guests } = req.body;
    if (!date || !time_text || !guests) {
      return res.status(400).json({ error: "Missing parameters" });
    }

    const normalizedDate = normalizeDateToFuture(date);
    const { start, end } = buildStartEnd(normalizedDate, time_text);

    console.log("NORMALIZED DATE:", normalizedDate);
    console.log("START:", start.toISOString());
    console.log("END:", end.toISOString());

    const formula = `
AND(
  {status}="bestätigt",
  {start_datetime} < DATETIME_PARSE("${end.toISOString()}"),
  {end_datetime} > DATETIME_PARSE("${start.toISOString()}")
)
`;

    console.log("FORMULA:", formula);

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

    const records = response.data.records || [];

    const overlappingGuests = records.reduce(
      (sum, r) => sum + (r.fields.guests || 0),
      0
    );

    const available = overlappingGuests + guests <= MAX_CAPACITY;

    console.log("OVERLAPPING GUESTS:", overlappingGuests);
    console.log("REQUESTED:", guests);
    console.log("AVAILABLE:", available);

    res.json({
      available,
      overlappingGuests,
      remainingSeats: MAX_CAPACITY - overlappingGuests,
    });
  } catch (err) {
    console.error("CHECK AVAILABILITY ERROR", err?.response?.data || err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ======================
// CREATE RESERVATION
// ======================
app.post("/create-reservation", async (req, res) => {
  console.log("=== CREATE RESERVATION START ===");
  console.log("RAW BODY:", req.body);

  try {
    const { date, time_text, guests, name = "", phone = "" } = req.body;
    if (!date || !time_text || !guests) {
      return res.status(400).json({ error: "Missing parameters" });
    }

    const normalizedDate = normalizeDateToFuture(date);
    const { start, end } = buildStartEnd(normalizedDate, time_text);

    console.log("NORMALIZED DATE:", normalizedDate);
    console.log("START:", start.toISOString());
    console.log("END:", end.toISOString());

    const airtablePayload = {
      fields: {
        date: normalizedDate,
        time_text,
        guests,
        name,
        phone,
        status: "bestätigt",
        // start_datetime & end_datetime NICHT setzen,
        // da diese in Airtable berechnet werden
      },
    };

    console.log("AIRTABLE PAYLOAD:", airtablePayload);

    const response = await axios.post(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE}`,
      airtablePayload,
      {
        headers: {
          Authorization: `Bearer ${AIRTABLE_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("AIRTABLE RECORD ID:", response.data.id);

    res.json({
      success: true,
      recordId: response.data.id,
    });
  } catch (err) {
    console.error("CREATE RESERVATION ERROR", err?.response?.data || err.message);
    res.status(500).json({ error: "Could not create reservation" });
  }
});

// ======================
// SERVER START
// ======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server läuft auf Port ${PORT}`);
});
