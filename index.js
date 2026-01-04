import express from "express";
import axios from "axios";
import cors from "cors";
import "dotenv/config";

const app = express();
app.use(cors());
app.use(express.json());

/* ================================
   KONFIGURATION
================================ */

const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const RESERVATIONS_TABLE = "Reservations";

const MAX_CAPACITY = 10;          // maximale Gäste gleichzeitig
const SLOT_DURATION_HOURS = 2;    // Sitzdauer pro Reservierung

/* ================================
   HILFSFUNKTIONEN
================================ */

/**
 * Wenn ein Datum ohne Jahr (oder mit vergangenem Jahr) kommt,
 * wird automatisch das nächstmögliche zukünftige Datum verwendet.
 * Beispiel:
 *  - heute 10.01.2026, date = 2024-01-06 → 2027-01-06
 *  - heute 03.01.2026, date = 2024-01-06 → 2026-01-06
 */
function normalizeDateToFuture(dateStr) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let target = new Date(dateStr);
  target.setHours(0, 0, 0, 0);

  // Jahr immer zuerst auf aktuelles Jahr setzen
  target.setFullYear(today.getFullYear());

  // Wenn Datum schon vorbei → nächstes Jahr
  if (target < today) {
    target.setFullYear(today.getFullYear() + 1);
  }

  return target.toISOString().slice(0, 10);
}


/* ================================
   HEALTH CHECK
================================ */

app.get("/", (req, res) => {
  res.json({ status: "ok" });
});

/* ================================
   CHECK AVAILABILITY
================================ */

app.post("/check-availability", async (req, res) => {
  try {
    console.log("=== CHECK AVAILABILITY START ===");

    const { date, time_text, guests } = req.body;

    const normalizedDate = normalizeDateToFuture(date);
    if (!normalizedDate || !time_text || !guests) {
      return res.status(400).json({ error: "Missing data" });
    }

    const start = new Date(`${normalizedDate}T${time_text}:00`);
    const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);

    console.log("REQUEST:", normalizedDate, time_text, guests);
    console.log("START:", start.toISOString());
    console.log("END:", end.toISOString());

    // 👉 Alle bestätigten Reservierungen am selben Tag holen
    const response = await axios.get(
      `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/Reservations`,
      {
        headers: {
          Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`,
        },
        params: {
          filterByFormula: `AND(
            {status}="bestätigt",
            {date}="${normalizedDate}"
          )`,
        },
      }
    );

    let totalGuests = 0;

    for (const record of response.data.records) {
      const rStart = new Date(record.fields.start_datetime);
      const rEnd = new Date(record.fields.end_datetime);

      const overlaps =
        start < rEnd &&
        end > rStart;

      if (overlaps) {
        totalGuests += record.fields.guests || 0;
      }
    }

    const MAX_CAPACITY = 10;
    const available = totalGuests + guests <= MAX_CAPACITY;

    console.log("OVERLAPPING GUESTS:", totalGuests);
    console.log("REQUESTED:", guests);
    console.log("AVAILABLE:", available);

    res.json({
      available,
      remainingSeats: MAX_CAPACITY - totalGuests,
    });

  } catch (err) {
    console.error("CHECK AVAILABILITY ERROR", err);
    res.status(500).json({ error: "Server error" });
  }
});



/* ================================
   CREATE RESERVATION
================================ */

app.post("/create-reservation", async (req, res) => {
  console.log("=== CREATE RESERVATION START ===");
  console.log("RAW BODY:", req.body);

  try {
    const { date, time_text, guests, name, phone } = req.body;

    const normalizedDate = normalizeDateToFuture(date);


    if (!date || !time_text || !guests) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields",
      });
    }

    const normalizedDate = normalizeDateToFuture(date);

    const start = new Date(`${normalizedDate}T${time_text}:00`);
    const end = new Date(
      start.getTime() + SLOT_DURATION_HOURS * 60 * 60 * 1000
    );

    console.log("NORMALIZED DATE:", normalizedDate);
    console.log("START:", start.toISOString());
    console.log("END:", end.toISOString());

    const payload = {
      fields: {
        date: normalizedDate,
        time_text,
        guests,
        status: "bestätigt",
        ...(name && { name }),
        ...(phone && { phone }),
      },
    };

    console.log("AIRTABLE PAYLOAD:", payload);

    const response = await axios.post(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${RESERVATIONS_TABLE}`,
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
      message: "Reservation created successfully",
      recordId: response.data.id,
    });

  } catch (error) {
    console.error("CREATE RESERVATION ERROR");
    console.error(error.response?.data || error.message);

    return res.status(500).json({
      success: false,
      message: "Could not create reservation",
    });
  }
});

/* ================================
   SERVER START
================================ */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`✅ Server läuft auf Port ${PORT}`);
});
