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

// =====================
// CHECK AVAILABILITY
// =====================
app.post("/check-availability", async (req, res) => {
  try {
    console.log("=== CHECK AVAILABILITY START ===");
    console.log("RAW BODY:", req.body);

    const { date, time_text, guests } = req.body;

    console.log("PARSED:", date, time_text, guests);

    const start = new Date(`${date}T${time_text}:00`);
    const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);

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
      `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/Reservations`,
      {
        headers: {
          Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`
        },
        params: { filterByFormula: formula }
      }
    );

    console.log("AIRTABLE RESPONSE OK");
    console.log("RECORD COUNT:", response.data.records.length);

    const totalGuests = response.data.records.reduce(
      (sum, r) => sum + (r.fields.guests || 0),
      0
    );

    console.log("TOTAL GUESTS:", totalGuests);

    const MAX_CAPACITY = 10;
    const available = totalGuests + guests <= MAX_CAPACITY;

    console.log("REQUESTED:", guests);
    console.log("AVAILABLE:", available);

    res.json({
      available,
      remainingSeats: Math.max(0, MAX_CAPACITY - totalGuests)
    });

  } catch (error) {
    console.error("❌ CHECK AVAILABILITY ERROR");
    console.error(error.response?.data || error.message);
    res.status(500).json({ error: "Server error" });
  }
});


// =====================
// CREATE RESERVATION
// =====================
app.post("/create-reservation", async (req, res) => {
  try {
    console.log("CREATE RESERVATION CALLED");
    console.log("RAW BODY:", req.body);

    const { date, time_text, guests, name, phone } = req.body;

    if (!date || !time_text || !guests) {
      return res.status(400).json({
        error: "Missing required fields",
        received: req.body
      });
    }

    const start = new Date(`${date}T${time_text}:00`);
    const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);

    const response = await axios.post(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE}`,
      {
        fields: {
          date,
          time_text,
          guests,
          name: name || "Telefon-Reservierung",
          phone: phone || "",
          status: "bestätigt",
          start_datetime: start.toISOString(),
          end_datetime: end.toISOString()
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
      recordId: response.data.id
    });

  } catch (error) {
    console.error("CREATE ERROR:", error.response?.data || error.message);
    res.status(500).json({ error: "Could not create reservation" });
  }
});

// =====================
// SERVER START
// =====================
app.listen(3000, () => {
  console.log("✅ Server läuft auf http://localhost:3000");
});
