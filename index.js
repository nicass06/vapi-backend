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

// VERBESSERTE FUNKTION: Verhindert den .split() Fehler
function timeToMinutes(timeStr) {
    if (!timeStr || typeof timeStr !== 'string') {
        console.error("Ungültiger timeStr empfangen:", timeStr);
        return 0; 
    }
    const parts = timeStr.split(":");
    if (parts.length < 2) return 0;
    const h = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    return h * 60 + m;
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
        console.error("Airtable Fehler (Opening):", e.message);
        return { closed: true, reason: "Fehler bei Abfrage" };
    }
}

// ============================
// ROUTES
// ============================

app.post("/check-availability", async (req, res) => {
    try {
        const { date, time_text, guests } = req.body;
        
        // Validierung der Eingabe
        if (!date || !time_text) {
            return res.json({ success: false, available: false, message: "Bitte Datum und Uhrzeit nennen." });
        }

        const normalizedDate = normalizeDate(date);
        const opening = await getOpeningForDate(normalizedDate);

        if (opening.closed) {
            return res.json({ success: false, available: false, message: `Am ${normalizedDate} haben wir geschlossen.` });
        }

        const reqMin = timeToMinutes(time_text);
        const openMin = timeToMinutes(opening.open);
        const closeMin = timeToMinutes(opening.close);

        if (reqMin < openMin || (reqMin + SLOT_DURATION_MIN) > closeMin) {
            return res.json({ 
                success: false, 
                available: false, 
                message: `Wir haben dann leider zu. Geöffnet: ${opening.open}-${opening.close}` 
            });
        }

        const resRecords = await axios.get(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${RESERVATIONS_TABLE}`, {
            headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
            params: { filterByFormula: `AND({status}="bestätigt", {date}="${normalizedDate}")` }
        });

        let currentLoad = 0;
        const newStart = reqMin;
        const newEnd = reqMin + SLOT_DURATION_MIN;

        resRecords.data.records.forEach(record => {
            const existingStart = timeToMinutes(record.fields.time_text);
            const existingEnd = existingStart + SLOT_DURATION_MIN;
            if (newStart < existingEnd && newEnd > existingStart) {
                currentLoad += (record.fields.guests || 0);
            }
        });

        if (currentLoad + parseInt(guests || 0) > MAX_CAPACITY) {
            return res.json({ success: true, available: false, message: "Leider ausgebucht." });
        }

        return res.json({ success: true, available: true });
    } catch (err) {
        console.error("Check Error:", err.message);
        res.json({ success: false, available: false, error: err.message });
    }
});

app.post("/create-reservation", async (req, res) => {
    try {
        const { date, time_text, guests, name } = req.body;
        
        if (!date || !time_text) {
             return res.json({ success: false, error: "Fehlende Daten für Reservierung" });
        }

        const phone = extractPhone(req);
        const normalizedDate = normalizeDate(date);
        const startISO = `${normalizedDate}T${time_text}:00.000Z`;
        
        await axios.post(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${RESERVATIONS_TABLE}`, {
            fields: {
                date: normalizedDate,
                time_text: String(time_text), // Sicherstellen, dass es ein String ist
                guests: parseInt(guests || 1),
                name: name || "Gast",
                phone: String(phone),
                status: "bestätigt",
                start_datetime: startISO
            }
        }, {
            headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, "Content-Type": "application/json" }
        });

        return res.json({ success: true });
    } catch (err) {
        console.error("Create Error:", err.response?.data || err.message);
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
            params: { 
                filterByFormula: `AND({phone}="${phone}", {date}="${normalizedDate}", {status}="bestätigt")` 
            }
        });

        if (search.data.records.length === 0) {
            return res.json({ success: false, reason: "not_found" });
        }

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