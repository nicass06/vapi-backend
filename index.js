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

const MAX_CAPACITY = process.env.MAX_CAPACITY;
const SLOT_DURATION_MIN = process.env.SLOT_DURATION;

// ========================
// HILFSFUNKTIONEN
// ========================

function extractPhone(req) {
    // Dieser Log zeigt uns ALLES, was Vapi sendet
    console.log("VOLLER REQUEST BODY:", JSON.stringify(req.body));

    const metadata = req.body.message?.call?.customer?.number || 
                     req.body.call?.customer?.number || 
                     req.body.customer?.number;
    
    if (metadata && metadata.length > 5 && !metadata.includes('{')) return metadata;

    const paramPhone = req.body.phone || req.body.message?.toolCalls?.[0]?.function?.arguments?.phone;
    if (paramPhone && paramPhone.length > 5 && !paramPhone.includes('{')) return paramPhone;

    return "Unbekannt";
}

function normalizeDate(dateInput) {
    if (!dateInput) return null;
    let today = new Date();
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
    } else {
        const parts = dateInput.split(".");
        if (parts.length >= 2) {
            let day = parseInt(parts[0], 10);
            let month = parseInt(parts[1], 10) - 1;
            let year = parts[2] ? parseInt(parts[2], 10) : today.getFullYear();
            candidate = new Date(year, month, day);
        } else {
            candidate = new Date(dateInput);
        }
    }
    return candidate.toISOString().slice(0, 10);
}

const timeToMinutes = (timeVal) => {
    if (!timeVal) return 0;
    if (typeof timeVal === 'number') return Math.floor(timeVal / 60);
    if (typeof timeVal === 'string') {
        const parts = timeVal.split(":");
        return parts.length < 2 ? 0 : parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
    }
    return 0;
};

const toHHMM = (min) => {
    const h = Math.floor(min / 60).toString().padStart(2, '0');
    const m = (min % 60).toString().padStart(2, '0');
    return `${h}:${m}`;
};

async function getOpeningForDate(dateISO) {
    const weekdayMap = ["Sonntag","Montag","Dienstag","Mittwoch","Donnerstag","Freitag","Samstag"];
    const germanWeekday = weekdayMap[new Date(dateISO).getDay()];
    try {
        const exRes = await axios.get(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${OPENING_EXCEPTIONS_TABLE}`, {
            headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
            params: { filterByFormula: `{date}='${dateISO}'` }
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
    } catch (e) { return { closed: true, reason: "Fehler bei Abfrage" }; }
}

// ========================
// ROUTES
// ========================

app.post("/check-availability", async (req, res) => {
    try {
        const { date, time_text, guests } = req.body.message?.toolCalls?.[0]?.function?.arguments || req.body;
        const normalizedDate = normalizeDate(date);
        const reqMin = timeToMinutes(time_text);
        const numGuests = parseInt(guests || 0);

        const opening = await getOpeningForDate(normalizedDate);
        if (opening.closed) return res.json({ success: true, available: false, message: `Wir haben am ${normalizedDate} leider geschlossen.` });

        const openMin = timeToMinutes(opening.open);
        const closeMin = timeToMinutes(opening.close);
        if (reqMin < openMin || (reqMin + SLOT_DURATION_MIN) > closeMin) {
            return res.json({ success: true, available: false, message: `Außerhalb der Öffnungszeiten.` });
        }

        const resRecords = await axios.get(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${RESERVATIONS_TABLE}`, {
            headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
            params: { filterByFormula: `{status}="bestätigt"` }
        });

        let currentLoad = 0;
        resRecords.data.records.forEach(record => {
            const fields = record.fields;
            if (fields.date === normalizedDate) {
                const existingStart = timeToMinutes(fields.time_text);
                const existingEnd = existingStart + SLOT_DURATION_MIN;
                if (reqMin < existingEnd && (reqMin + SLOT_DURATION_MIN) > existingStart) {
                    currentLoad += (parseInt(fields.guests) || 0);
                }
            }
        });

        if (currentLoad + numGuests > MAX_CAPACITY) return res.json({ success: true, available: false, message: "Leider ausgebucht." });
        return res.json({ success: true, available: true });
    } catch (err) { res.json({ success: false, error: err.message }); }
});

app.post("/create-reservation", async (req, res) => {
    try {
        const { date, time_text, guests, name } = req.body.message?.toolCalls?.[0]?.function?.arguments || req.body;
        const phone = extractPhone(req);
        const normalizedDate = normalizeDate(date);
        const reqMin = timeToMinutes(time_text);

        const startISO = `${normalizedDate}T${time_text}:00.000Z`;
        const endISO = `${normalizedDate}T${toHHMM(reqMin + 120)}:00.000Z`;

        await axios.post(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${RESERVATIONS_TABLE}`, {
            fields: {
                date: normalizedDate,
                time_text,
                guests: parseInt(guests || 1),
                name,
                phone,
                status: "bestätigt",
                start_datetime: startISO,
                end_datetime: endISO
            }
        }, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });

        return res.json({ success: true });
    } catch (err) { res.json({ success: false, error: err.message }); }
});

app.post("/get-reservation-by-phone", async (req, res) => {
    try {
        const phone = extractPhone(req);
        const cleanPhone = phone.replace(/[^\d+]/g, ''); 
        
        console.log(`--- SICHERE SUCHE START ---`);
        console.log(`Suche nach: ${cleanPhone}`);

        // FILTER-UPDATE: 
        // 1. NOT({phone} = '') stellt sicher, dass das Feld nicht leer ist.
        // 2. SEARCH vergleicht dann die Nummer.
        const filter = `AND(
            NOT({phone} = ''),
            SEARCH('${cleanPhone}', SUBSTITUTE({phone}, ' ', '')),
            {status}='bestätigt'
        )`;

        const search = await axios.get(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${RESERVATIONS_TABLE}`, {
            headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
            params: { 
                filterByFormula: filter,
                sort: [{ field: "date", direction: "desc" }] // Immer die aktuellste zuerst
            }
        });

        if (search.data.records.length === 0) {
            console.log("Kein echter Treffer mit Nummer gefunden.");
            return res.json({ success: false });
        }

        const record = search.data.records[0];
        console.log(`Treffer gefunden! Name: ${record.fields.name}, Datum: ${record.fields.date}`);

        return res.json({
            success: true,
            reservation_id: record.id,
            date: record.fields.date,
            time: record.fields.time_text,
            name: record.fields.name
        });
    } catch (err) {
        console.error("Suche fehlgeschlagen:", err.message);
        res.json({ success: false, error: err.message });
    }
});
app.post("/cancel-reservation", async (req, res) => {
    try {
        // Wir fischen die ID aus allen möglichen Vapi-Strukturen
        const reservation_id = req.body.reservation_id || 
                               req.body.message?.toolCalls?.[0]?.function?.arguments?.reservation_id;

        console.log("DEBUG: Versuche Storno für ID:", reservation_id);

        if (!reservation_id) {
            console.error("Fehler: Keine ID im Request gefunden!");
            return res.json({ success: false, message: "ID fehlt" });
        }

        await axios.patch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${RESERVATIONS_TABLE}/${reservation_id}`, 
            { fields: { status: "storniert" } },
            { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, "Content-Type": "application/json" } }
        );

        console.log("Erfolg: Status in Airtable auf storniert gesetzt.");
        return res.json({ success: true });
    } catch (err) {
        console.error("Airtable Fehler:", err.response?.data || err.message);
        res.json({ success: false, error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));