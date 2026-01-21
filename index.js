import express from "express";
import axios from "axios";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const RESERVATIONS_TABLE = "Reservations";
const OPENING_HOURS_TABLE = "opening_hours";
const OPENING_EXCEPTIONS_TABLE = "opening_exceptions";

const MAX_CAPACITY = 10;
const SLOT_DURATION_MIN = 120;

// ============================
// HILFSFUNKTIONEN
// ============================

function extractPhone(req) {
    return req.body?.message?.call?.customer?.number || 
           req.body?.customer?.number ||
           req.body?.call?.from || 
           "";
}

function normalizeDate(dateInput) {
    if (!dateInput) throw new Error("Kein Datum angegeben");
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let candidate;
    const lowerInput = dateInput.toLowerCase();

    if (lowerInput === "today" || lowerInput === "heute") {
        candidate = new Date(today);
    } else if (lowerInput === "tomorrow" || lowerInput === "morgen") {
        candidate = new Date(today);
        candidate.setDate(candidate.getDate() + 1);
    } else if (lowerInput === "day_after_tomorrow" || lowerInput === "übermorgen") {
        candidate = new Date(today);
        candidate.setDate(candidate.getDate() + 2);
    } else if (["monday","tuesday","wednesday","thursday","friday","saturday","sunday"].includes(lowerInput)) {
        const map = { sunday:0, monday:1, tuesday:2, wednesday:3, thursday:4, friday:5, saturday:6 };
        const diff = (map[lowerInput] + 7 - today.getDay()) % 7 || 7;
        candidate = new Date(today);
        candidate.setDate(candidate.getDate() + diff);
    } else {
        const parts = dateInput.split(".");
        const day = parseInt(parts[0], 10);
        const month = parseInt(parts[1], 10) - 1;
        let year = parts[2] ? parseInt(parts[2], 10) : today.getFullYear();
        candidate = new Date(year, month, day);
    }

    if (candidate < today) {
        candidate.setFullYear(candidate.getFullYear() + 1);
    }
    return candidate.toISOString().slice(0, 10);
}

/**
 * VERBESSERTE FUNKTION: Verarbeitet "17:00" (String) UND 61200 (Sekunden aus Airtable)
 */
function timeToMinutes(timeVal) {
    if (timeVal === undefined || timeVal === null) return 0;

    // Fall 1: Airtable liefert Sekunden als Zahl (z.B. 61200)
    if (typeof timeVal === 'number') {
        return Math.floor(timeVal / 60);
    }

    // Fall 2: Vapi/Airtable liefert String (z.B. "17:00")
    if (typeof timeVal === 'string') {
        const parts = timeVal.split(":");
        if (parts.length < 2) return 0;
        return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
    }

    return 0;
}

async function getOpeningForDate(dateISO) {
    const weekdayMap = ["Sonntag","Montag","Dienstag","Mittwoch","Donnerstag","Freitag","Samstag"];
    const germanWeekday = weekdayMap[new Date(dateISO).getDay()];

    try {
        const exRes = await axios.get(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${OPENING_EXCEPTIONS_TABLE}`, {
            headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
            params: { filterByFormula: `{date}="${dateISO}"` }
        });

        if (exRes.data.records.length > 0) {
            const ex = exRes.data.records[0].fields;
            if (ex.closed) return { closed: true, reason: ex.reason || "geschlossen" };
            return { closed: false, open: ex.open_time, close: ex.close_time };
        }

        const hoursRes = await axios.get(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${OPENING_HOURS_TABLE}`, {
            headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
            params: { filterByFormula: `AND({restaurant_id}="main", {weekday}="${germanWeekday}")` }
        });

        if (hoursRes.data.records.length === 0) return { closed: true, reason: "Kein Eintrag" };
        const fields = hoursRes.data.records[0].fields;
        return { closed: false, open: fields.open_time, close: fields.close_time };
    } catch (e) {
        return { closed: true, reason: "Fehler bei Abfrage" };
    }
}

// ============================
// ROUTES
// ============================

app.post("/check-availability", async (req, res) => {
    try {
        const { date, time_text, guests } = req.body;
        if (!date || !time_text) return res.json({ success: false, available: false, message: "Daten unvollständig." });

        const normalizedDate = normalizeDate(date);
        const opening = await getOpeningForDate(normalizedDate);

        if (opening.closed) return res.json({ success: false, available: false, message: "Wir haben geschlossen." });

        const reqMin = timeToMinutes(time_text);
        const openMin = timeToMinutes(opening.open);
        const closeMin = timeToMinutes(opening.close);

        if (reqMin < openMin || (reqMin + SLOT_DURATION_MIN) > closeMin) {
            return res.json({ success: false, available: false, message: "Außerhalb der Öffnungszeiten." });
        }

        const resRecords = await axios.get(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${RESERVATIONS_TABLE}`, {
            headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
            params: { filterByFormula: `AND({status}="bestätigt", {date}="${normalizedDate}")` }
        });

        let currentLoad = 0;
        resRecords.data.records.forEach(record => {
            const existingStart = timeToMinutes(record.fields.time_text);
            const existingEnd = existingStart + SLOT_DURATION_MIN;
            if (reqMin < existingEnd && (reqMin + SLOT_DURATION_MIN) > existingStart) {
                currentLoad += (record.fields.guests || 0);
            }
        });

        if (currentLoad + parseInt(guests || 0) > MAX_CAPACITY) {
            return res.json({ success: true, available: false, message: "Leider ausgebucht." });
        }

        return res.json({ success: true, available: true });
    } catch (err) {
        res.json({ success: false, available: false, error: err.message });
    }
});

app.post("/create-reservation", async (req, res) => {
    try {
        const { date, time_text, guests, name } = req.body;
        const normalizedDate = normalizeDate(date);
        const reqMin = timeToMinutes(time_text);
        const numGuests = parseInt(guests || 1);

        // 1. SICHERHEITS-CHECK: Nochmal Kapazität prüfen vor dem Schreiben
        const resRecords = await axios.get(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${RESERVATIONS_TABLE}`, {
            headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
            params: { filterByFormula: `AND({status}="bestätigt", {date}="${normalizedDate}")` }
        });

        let currentLoad = 0;
        resRecords.data.records.forEach(record => {
            const existingStart = timeToMinutes(record.fields.time_text);
            const existingEnd = existingStart + SLOT_DURATION_MIN;
            if (reqMin < existingEnd && (reqMin + SLOT_DURATION_MIN) > existingStart) {
                currentLoad += (parseInt(record.fields.guests) || 0);
            }
        });

        if (currentLoad + numGuests > MAX_CAPACITY) {
            return res.json({ success: false, error: "Kapazität während der Buchung überschritten." });
        }

        // 2. RESERVIERUNG SCHREIBEN (inkl. end_datetime)
        const toHHMM = (min) => {
            const h = Math.floor(min / 60).toString().padStart(2, '0');
            const m = (min % 60).toString().padStart(2, '0');
            return `${h}:${m}`;
        };

        const startISO = `${normalizedDate}T${time_text}:00.000Z`;
        const endISO = `${normalizedDate}T${toHHMM(reqMin + SLOT_DURATION_MIN)}:00.000Z`;

        await axios.post(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${RESERVATIONS_TABLE}`, {
            fields: {
                date: normalizedDate,
                time_text: String(time_text),
                guests: numGuests,
                name: name || "Gast",
                phone: String(extractPhone(req)),
                status: "bestätigt",
                start_datetime: startISO,
                end_datetime: endISO
            }
        }, {
            headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, "Content-Type": "application/json" }
        });

        return res.json({ success: true });
    } catch (err) {
        console.error("Create Error:", err.message);
        res.json({ success: false, error: err.message });
    }
});

app.post("/cancel-reservation", async (req, res) => {
    try {
        const { date, time_text } = req.body;
        const phone = extractPhone(req);
        const normalizedDate = normalizeDate(date);

        const search = await axios.get(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${RESERVATIONS_TABLE}`, {
            headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
            params: { filterByFormula: `AND({phone}="${phone}", {date}="${normalizedDate}", {status}="bestätigt")` }
        });

        if (search.data.records.length === 0) return res.json({ success: false, reason: "not_found" });

        await axios.patch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${RESERVATIONS_TABLE}/${search.data.records[0].id}`, 
            { fields: { status: "storniert" } },
            { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
        );

        return res.json({ success: true });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));