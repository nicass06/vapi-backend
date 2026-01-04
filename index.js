import express from "express";
import axios from "axios";
import cors from "cors";
import "dotenv/config";

const app = express();
app.use(cors());
app.use(express.json());

// =====================
// KONFIG
// =====================
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_TABLE = "Reservations";
const MAX_CAPACITY = 10; // <<< HIER DEINE MAX KAPAZITÄT

function buildDateWithSmartYear(day, month, timeText) {
  const now = new Date();
  let year = now.getFullYear();

  // Monat in JS ist 0-basiert
  const candidate = new Date(`${year}-${month}-${day}T${timeText}:00`);

  // Wenn Datum schon vorbei ist → nächstes Jahr
  if (candidate < now) {
    year += 1;
  }

  return new Date(`${year}-${month}-${day}T${timeText}:00`);
}


// =====================
// CHECK AVAILABILITY
// =====================
app.post("/check-availability", async (req, res) => {
  console.log("=== CHECK AVAILABILITY START ===");
  console.log("RAW BODY:", req.body);

  try {
    const { date, time_text, guests } = req.body;

    // 🔒 Validierung
    if (!date || !time_text || !guests) {
      console.error("❌ Missing fields");
      return res.status(400).json({ error: "Missing required fields" });
    }

    // 🕒 Start- & Endzeit (2 Stunden Block)
    const start = new Date(`${date}T${time_text}:00`);
    const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);

    console.log("PARSED:", date, time_text, guests);
    console.log("START:", start.toISOString());
    console.log("END:", end.toISOString());

    // 🧠 Airtable-Overlap-Formel
    const formula = `
AND(
  {status}="bestätigt",
  {start_datetime} < DATETIME_PARSE("${end.toISOString()}"),
  {end_datetime} > DATETIME_PARSE("${start.toISOString()}")
)
`.trim();

    console.log("FORMULA:");
    console.log(formula);

    // 📡 Airtable abfragen
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

    console.log("AIRTABLE RESPONSE OK");
    console.log("RECORD COUNT:", response.data.records.length);

    // ➕ Gäste summieren
    const totalGuests = response.data.records.reduce(
      (sum, r) => sum + (r.fields.guests || 0),
      0
    );

    console.log("TOTAL GUESTS:", totalGuests);
    console.log("REQUESTED:", guests);

    const available = totalGuests + guests <= MAX_CAPACITY;

    console.log("AVAILABLE:", available);

    // ✅ Antwort an VAPI
    return res.json({
      available,
      remainingSeats: MAX_CAPACITY - totalGuests,
      requestedGuests: guests,
      alreadyBooked: totalGuests,
    });

  } catch (error) {
    console.error("❌ CHECK AVAILABILITY ERROR");
    console.error(error.response?.data || error.message);

    return res.status(500).json({ error: "Server error" });
  }
});




// =====================
// CREATE RESERVATION
// =====================
app.post("/create-reservation", async (req, res) => {
  console.log("=== CREATE RESERVATION START ===");
  console.log("RAW BODY:", req.body);

  try {
    const { day, month, time_text, guests, name, phone } = req.body;

    if (!day || !month || !time_text || !guests) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // 🔑 GLEICHE ZEITLOGIK WIE BEI CHECK
    const start = buildDateWithSmartYear(day, month, time_text);
    const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);

    console.log("START:", start.toISOString());
    console.log("END:", end.toISOString());

    const payload = {
      fields: {
        start_datetime: start.toISOString(),
        end_datetime: end.toISOString(),
        day,
        month,
        time_text,
        guests,
        status: "bestätigt",
        name: name || "",
        phone: phone || ""
      }
    };

    console.log("AIRTABLE PAYLOAD:", payload);

    const response = await axios.post(
      `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/Reservations`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log("✅ AIRTABLE RECORD CREATED:", response.data.id);

    res.json({
      success: true,
      recordId: response.data.id
    });

  } catch (error) {
    console.error("❌ CREATE RESERVATION ERROR");

    if (error.response) {
      console.error("STATUS:", error.response.status);
      console.error("DATA:", error.response.data);
    } else {
      console.error(error.message);
    }

    res.status(500).json({ error: "Could not create reservation" });
  }
});


app.listen(3000, () => {
  console.log("✅ Server läuft auf http://localhost:3000");
});
