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
function normalizeDateToFuture(dateString) {
  const now = new Date();

  const candidate = new Date(dateString + "T00:00:00");

  if (candidate < now) {
    const corrected = new Date(
      now.getFullYear(),
      candidate.getMonth(),
      candidate.getDate()
    );

    // Falls der Tag im aktuellen Jahr schon vorbei ist → nächstes Jahr
    if (corrected < now) {
      corrected.setFullYear(corrected.getFullYear() + 1);
    }

    return corrected.toISOString().split("T")[0];
  }

  return dateString;
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
  console.log("=== CHECK AVAILABILITY START ===");
  console.log("RAW BODY:", req.body);

  try {
    const { date, time_text, guests } = req.body;

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

    // 🔑 Overlap-Logik (2-Stunden-Fenster)
    const formula = `
AND(
  {status}="bestätigt",
  {start_datetime} < "${end.toISOString()}",
  {end_datetime} > "${start.toISOString()}"
)
`.trim();

    console.log("FORMULA:", formula);

    const response = await axios.get(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${RESERVATIONS_TABLE}`,
      {
        headers: {
          Authorization: `Bearer ${AIRTABLE_TOKEN}`,
        },
        params: {
          filterByFormula: formula,
        },
      }
    );

    const totalGuests = response.data.records.reduce(
      (sum, r) => sum + (r.fields.guests || 0),
      0
    );

    const available = totalGuests + guests <= MAX_CAPACITY;

    console.log("TOTAL GUESTS:", totalGuests);
    console.log("REQUESTED:", guests);
    console.log("AVAILABLE:", available);

    return res.json({
      success: true,
      available,
      remainingSeats: Math.max(0, MAX_CAPACITY - totalGuests),
      alreadyBooked: totalGuests,
    });

  } catch (error) {
    console.error("CHECK AVAILABILITY ERROR");
    console.error(error.response?.data || error.message);

    return res.status(500).json({
      success: false,
      message: "Server error",
    });
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
        start_datetime: start.toISOString(),
        end_datetime: end.toISOString(),
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
