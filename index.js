import express from "express";
import axios from "axios";
import cors from "cors";
import "dotenv/config";

const app = express();
app.use(cors());
app.use(express.json());

// 🔴 HIER SPÄTER ANPASSEN
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE = "Reservations";
const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const MAX_CAPACITY = 100;


// Hilfsfunktion
function toISO(date, time) {
  return `${date}T${time}:00`;
}

// API-Endpunkt
app.post("/check-availability", async (req, res) => {
  try {
    const { date, time_text, guests } = req.body;

    const time = time_text; // <-- WICHTIG


    const start = new Date(toISO(date, time));
    const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);

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

    const totalGuests = response.data.records.reduce(
      (sum, r) => sum + (r.fields.guests || 0),
      0
    );

    const available = totalGuests + guests <= MAX_CAPACITY;

    res.json({
      available,
      remainingSeats: MAX_CAPACITY - totalGuests,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Server error" });
  }
});

// Server starten
app.listen(3000, () => {
  console.log("✅ Server läuft auf http://localhost:3000");
});
