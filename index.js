import express from "express";
import axios from "axios";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

// ============================
// ENV
// ============================
const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE;

// ============================
// DATE NORMALIZATION (ROBUST)
// ============================
function normalizeDate(dateInput) {
  if (!dateInput || typeof dateInput !== "string") {
    throw new Error("Invalid date format");
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let candidate;

  // relative dates
  if (dateInput === "today") {
    candidate = new Date(today);
  } else if (dateInput === "tomorrow") {
    candidate = new Date(today);
    candidate.setDate(candidate.getDate() + 1);
  } else if (dateInput === "day_after_tomorrow") {
    candidate = new Date(today);
    candidate.setDate(candidate.getDate() + 2);
  }

  // weekdays
  else if (
    ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"]
      .includes(dateInput)
  ) {
    const map = {
      sunday: 0,
      monday: 1,
      tuesday: 2,
      wednesday: 3,
      thursday: 4,
      friday: 5,
      saturday: 6
    };

    const target = map[dateInput];
    candidate = new Date(today);
    const diff = (target + 7 - candidate.getDay()) % 7 || 7;
    candidate.setDate(candidate.getDate() + diff);
  }

  // ISO yyyy-mm-dd
  else if (/^\d{4}-\d{2}-\d{2}$/.test(dateInput)) {
    candidate = new Date(dateInput + "T00:00:00");
  }

  // dd.mm or d.m
  else if (/^\d{1,2}\.\d{1,2}\.?$/.test(dateInput)) {
    const parts = dateInput.replace(".", "").split(".");
    const day = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10) - 1;
    candidate = new Date(today.getFullYear(), month, day);
  }

  else {
    throw new Error("Invalid date format");
  }

  candidate.setHours(0, 0, 0, 0);

  // always future
  while (candidate < today) {
    candidate.setFullYear(candidate.getFullYear() + 1);
  }

  return candidate.toISOString().slice(0, 10);
}

// ============================
// HEALTH
// ============================
app.get("/", (req, res) => {
  res.json({ status: "ok" });
});

// ============================
// CREATE RESERVATION
// ============================
app.post("/create-reservation", async (req, res) => {
  try {
    console.log("=== CREATE RESERVATION ===");
    console.log(JSON.stringify(req.body, null, 2));

    const { date, time_text, guests, name = "" } = req.body;

    if (!date || !time_text || !guests) {
      return res.status(400).json({ success: false });
    }

    const phone =
      typeof req.body.phone === "string" && req.body.phone.trim() !== ""
        ? req.body.phone.trim()
        : "";

    const normalizedDate = normalizeDate(date);

    const payload = {
      fields: {
        date: normalizedDate,
        time_text,
        guests,
        name,
        phone,
        status: "bestätigt"
      }
    };

    await axios.post(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE}`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${AIRTABLE_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    return res.json({
      success: true,
      message: "Reservation created"
    });

  } catch (err) {
    console.error("CREATE ERROR:", err.message);
    return res.status(200).json({
      success: false,
      message: "technical_error"
    });
  }
});

// ============================
// CANCEL RESERVATION
// ============================
app.post("/cancel-reservation", async (req, res) => {
  try {
    console.log("=== CANCEL RESERVATION ===");
    console.log(JSON.stringify(req.body, null, 2));

    const { date, time_text } = req.body;
    if (!date || !time_text) {
      return res.status(400).json({ success: false });
    }

    const phone =
      typeof req.body.phone === "string" && req.body.phone.trim() !== ""
        ? req.body.phone.trim()
        : "";

    const normalizedDate = normalizeDate(date);

    const formulaParts = [
      `{status}="bestätigt"`,
      `{date}="${normalizedDate}"`,
      `{time_text}="${time_text}"`
    ];

    if (phone) {
      formulaParts.push(`{phone}="${phone}"`);
    }

    const filterFormula = `AND(${formulaParts.join(",")})`;

    const search = await axios.get(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE}`,
      {
        headers: {
          Authorization: `Bearer ${AIRTABLE_TOKEN}`
        },
        params: { filterByFormula }
      }
    );

    if (search.data.records.length === 0) {
      return res.json({ success: false, message: "not_found" });
    }

    const recordId = search.data.records[0].id;

    await axios.patch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE}/${recordId}`,
      { fields: { status: "storniert" } },
      {
        headers: {
          Authorization: `Bearer ${AIRTABLE_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    return res.json({
      success: true,
      message: "Reservation cancelled"
    });

  } catch (err) {
    console.error("CANCEL ERROR:", err.message);
    return res.status(200).json({
      success: false,
      message: "technical_error"
    });
  }
});

// ============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
