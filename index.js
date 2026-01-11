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
const RESERVATIONS_TABLE = "Reservations";
const OPENING_HOURS_TABLE = "opening_hours";
const OPENING_EXCEPTIONS_TABLE = "opening_exceptions";

// ============================
// SETTINGS
// ============================
const MAX_CAPACITY = 10;
const SLOT_DURATION_MIN = 120;

// ============================
// DATE NORMALIZATION
// ============================
function normalizeDate(dateInput) {
  if (!dateInput || typeof dateInput !== "string") {
    throw new Error("Invalid date format");
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let candidate;

  if (dateInput === "today") candidate = new Date(today);
  else if (dateInput === "tomorrow") {
    candidate = new Date(today);
    candidate.setDate(candidate.getDate() + 1);
  } else if (dateInput === "day_after_tomorrow") {
    candidate = new Date(today);
    candidate.setDate(candidate.getDate() + 2);
  } else if (["monday","tuesday","wednesday","thursday","friday","saturday","sunday"].includes(dateInput)) {
    const map = { sunday:0, monday:1, tuesday:2, wednesday:3, thursday:4, friday:5, saturday:6 };
    candidate = new Date(today);
    const diff = (map[dateInput] + 7 - candidate.getDay()) % 7 || 7;
    candidate.setDate(candidate.getDate() + diff);
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(dateInput)) {
    candidate = new Date(dateInput + "T00:00:00");
  } else if (/^\d{1,2}\.\d{1,2}\.?$/.test(dateInput)) {
    const parts = dateInput.replace(".", "").split(".");
    const day = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10) - 1;
    candidate = new Date(today.getFullYear(), month, day);
  } else {
    throw new Error("Invalid date format");
  }

  candidate.setHours(0, 0, 0, 0);
  while (candidate < today) candidate.setFullYear(candidate.getFullYear() + 1);

  return candidate.toISOString().slice(0, 10);
}

// ============================
// OPENING HOURS
// ============================
function getGermanWeekday(dateISO) {
  const map = ["Sonntag","Montag","Dienstag","Mittwoch","Donnerstag","Freitag","Samstag"];
  return map[new Date(dateISO).getDay()];
}

async function getOpeningForDate(dateISO) {
  // 1) Exceptions
  const exRes = await axios.get(
    `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${OPENING_EXCEPTIONS_TABLE}`,
    {
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
      params: { filterByFormula: `{date}="${dateISO}"` }
    }
  );

  if (exRes.data.records.length > 0) {
    const ex = exRes.data.records[0].fields;
    if (ex.closed) return { closed: true, reason: ex.reason || "geschlossen" };
    if (ex.open_time && ex.close_time) {
      return { closed: false, open: ex.open_time, close: ex.close_time };
    }
  }

  // 2) Regular weekday hours
  const weekdayDE = getGermanWeekday(dateISO);

  const hoursRes = await axios.get(
    `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${OPENING_HOURS_TABLE}`,
    {
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
      params: {
        filterByFormula: `AND({restaurant_id}="main", {weekday}="${weekdayDE}")`
      }
    }
  );

  if (hoursRes.data.records.length === 0) {
    return { closed: true, reason: "Kein Öffnungseintrag" };
  }

  const fields = hoursRes.data.records[0].fields;
  return { closed: false, open: fields.open_time, close: fields.close_time };
}

app.post("/check-availability", async (req, res) => {
  try {
    const { date, time_text, guests } = req.body;
    if (!date || !time_text || !guests) {
      return res.json({ success: false, reason: "missing_parameters" });
    }

    const normalizedDate = normalizeDate(date);
    const opening = await getOpeningForDate(normalizedDate);

    if (opening.closed) {
      return res.json({
        success: false,
        reason: "closed",
        message: "An diesem Tag haben wir geschlossen."
      });
    }

    const [h, m] = time_text.split(":").map(Number);
    const requestMinutes = h * 60 + m;

    const openStr = String(opening.open);
const closeStr = String(opening.close);

const [oh, om] = openStr.split(":").map(Number);
const [ch, cm] = closeStr.split(":").map(Number);

    const openMinutes = oh * 60 + om;
    const closeMinutes = ch * 60 + cm;

    if (requestMinutes < openMinutes || requestMinutes + SLOT_DURATION_MIN > closeMinutes) {
      return res.json({
        success: false,
        reason: "outside_opening_hours",
        message: `Wir sind von ${opening.open} bis ${opening.close} geöffnet.`
      });
    }

    // Overlap & capacity
    const startISO = `${normalizedDate}T${time_text}:00.000Z`;
    const endDate = new Date(new Date(startISO).getTime() + SLOT_DURATION_MIN * 60000).toISOString();

    const records = await axios.get(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${RESERVATIONS_TABLE}`,
      {
        headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
        params: {
          filterByFormula: `AND({status}="bestätigt",{date}="${normalizedDate}")`
        }
      }
    );

    let totalGuests = 0;

    records.data.records.forEach(r => {
      const s = r.fields.start_datetime;
      const e = r.fields.end_datetime;
      if (s && e && !(endDate <= s || startISO >= e)) {
        totalGuests += r.fields.guests || 0;
      }
    });

    if (totalGuests + guests > MAX_CAPACITY) {
      return res.json({
        success: false,
        reason: "full",
        available: false,
        total_guests: totalGuests
      });
    }

    return res.json({
      success: true,
      available: true,
      total_guests: totalGuests
    });

  } catch (err) {
    console.error("CHECK AVAILABILITY ERROR:", err.message);
    return res.json({ success: false, reason: "technical_error" });
  }
});

app.post("/create-reservation", async (req, res) => {
  try {
    const { date, time_text, guests, name = "" } = req.body;
    if (!date || !time_text || !guests) {
      return res.json({ success: false, reason: "missing_parameters" });
    }

    const phone =
      typeof req.body.phone === "string" && req.body.phone.trim() !== ""
        ? req.body.phone.trim()
        : "";

    // Reuse availability check logic
    const availability = await axios.post(
      "http://localhost:3000/check-availability",
      { date, time_text, guests }
    );

    if (!availability.data.success || !availability.data.available) {
      return res.json({ success: false, reason: "not_available" });
    }

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
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${RESERVATIONS_TABLE}`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${AIRTABLE_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    return res.json({ success: true });

  } catch (error) {
  console.error("CREATE ERROR FULL:", error.response?.data || error.message || error);
  res.status(500).json({
    error: "Create reservation failed",
    details: error.response?.data || error.message || String(error)
  });
}

});

app.post("/cancel-reservation", async (req, res) => {
  try {
    const { date, time_text } = req.body;
    if (!date || !time_text) return res.json({ success: false });

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
    if (phone) formulaParts.push(`{phone}="${phone}"`);

    const filterByFormula = `AND(${formulaParts.join(",")})`;

    const search = await axios.get(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${RESERVATIONS_TABLE}`,
      {
        headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
        params: { filterByFormula }
      }
    );

    if (search.data.records.length === 0) {
      return res.json({ success: false, reason: "not_found" });
    }

    const recordId = search.data.records[0].id;

    await axios.patch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${RESERVATIONS_TABLE}/${recordId}`,
      { fields: { status: "storniert" } },
      {
        headers: {
          Authorization: `Bearer ${AIRTABLE_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    return res.json({ success: true });

  } catch (err) {
    console.error("CANCEL ERROR:", err.message);
    return res.json({ success: false, reason: "technical_error" });
  }
});

// ============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});


