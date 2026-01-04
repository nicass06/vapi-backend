import express from "express";
import axios from "axios";
import cors from "cors";
import "dotenv/config";

const app = express();
app.use(cors());
app.use(express.json());

// =====================
// CONFIG
// =====================
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE = "Reservations";
const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;

const MAX_CAPACITY = 10;
const SLOT_DURATION_MS = 2 * 60 * 60 * 1000;

// =====================
// HELPERS
// =====================

// yyyy-mm-dd + HH:mm → Date (UTC safe)
function buildDateTime(date, timeText) {
  return new Date(`${date}T${timeText}:00.000Z`);
}

// Wenn User kein Jahr sagt → nächstes sinnvolles Datum
function normalizeDate(dateStr) {
  const today = new Date();
  const [y, m, d] = dateStr.split("-").map(Number);

  // Falls Jahr fehlt → aktuelles oder nächstes Jahr
  if (!y || y < 2000) {
    const candidate = new Date(today.getFullYear(), m - 1, d);
    if (candidate < today) {
      candidate.setFullYear(today.getFullYear() + 1);
    }
    return candidate.toISOString().slice(0, 10);
  }

  return dateStr;
}

// =====================
// CHECK AVAILABILITY
// =====================
app.post("/check-availability", async (req, res) => {
  try {
    console.log("=== CHECK AVAILABILITY START ===");
    console.log("RAW BODY:", req.body);

    let { date, time_text, guests } = req.body;
    guests = Number(guests);

    const normalizedDate = normalizeDate(date);
    const start = buildDateTime(normalizedDate, time_text);
    const end = new Date(start.getTime() + SLOT_DURATION_MS - 1);

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

    console.log("OVERLAPPING GUESTS:", overlappingGuests);
    console.log("REQUESTED:", guests);

    const available = overlappingGuests + guests <= MAX_CAPACITY;

    console.log("AVAILABLE:", available);

    res.json({
      available,
      overlappingGuests,
      remainingSeats: MAX_CAPACITY - overlappingGuests,
    });
  } catch (err) {
    console.error("CHECK AVAILABILITY ERROR", err.response?.data || err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// =====================
// CREATE RESERVATION
// =====================
app.post("/create-reservation", async (req, res) => {
  try {
    console.log("=== CREATE RESERVATION START ===");
    console.log("RAW BODY:", req.body);

    let { date, time_text, guests, name = "", phone = "" } = req.body;
    guests = Number(guests);

    const normalizedDate = normalizeDate(date);
    const start = buildDateTime(normalizedDate, time_text);
    const end = new Date(start.getTime() + SLOT_DURATION_MS - 1);

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

    res.json({ success: true, recordId: response.data.id });
  } catch (err) {
    console.error("CREATE RESERVATION ERROR", err.response?.data || err.message);
    res.status(500).json({ error: "Could not create reservation" });
  }
});

// =====================
// START SERVER
// =====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server läuft auf Port ${PORT}`);
});
