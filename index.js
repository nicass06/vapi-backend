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

const MAX_CAPACITY = parseInt(process.env.MAX_CAPACITY || "15", 10);
const SLOT_DURATION_MIN = parseInt(process.env.SLOT_DURATION || "120", 10);

// ========================
// HILFSFUNKTIONEN
// ========================

// Diese Funktion gibt ein Objekt mit beiden Formaten zurück
function getFormattedDate(dateInput) {
    let candidate = new Date();
    candidate.setHours(0, 0, 0, 0);
    
    if (dateInput) {
        const lowerInput = dateInput.toLowerCase();
        if (lowerInput.includes("morgen") && !lowerInput.includes("über")) {
            candidate.setDate(candidate.getDate() + 1);
        } else if (lowerInput.includes("übermorgen")) {
            candidate.setDate(candidate.getDate() + 2);
        } else if (!lowerInput.includes("heute") && lowerInput !== "today") {
            const parts = dateInput.split(".");
            if (parts.length >= 2) {
                let day = parseInt(parts[0], 10);
                let month = parseInt(parts[1], 10) - 1;
                let year = parts[2] ? parseInt(parts[2], 10) : candidate.getFullYear();
                if (year < 100) year += 2000;
                candidate = new Date(year, month, day);
            } else {
                candidate = new Date(dateInput);
            }
        }
    }

    const d = String(candidate.getDate()).padStart(2, '0');
    const m = String(candidate.getMonth() + 1).padStart(2, '0');
    const y = candidate.getFullYear();

    return {
        german: `${d}.${m}.${y}`, // Für Airtable Suche
        iso: `${y}-${m}-${d}`,    // Für Wochentag-Berechnung
        jsDate: candidate         // Als Objekt
    };
}

const timeToMinutes = (timeVal) => {
    if (!timeVal) return 0;
    if (typeof timeVal === 'number') return Math.floor(timeVal / 60);
    const parts = String(timeVal).split(":");
    if (parts.length < 2) return 0;
    return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
};

const toHHMM = (min) => {
    const h = Math.floor(min / 60).toString().padStart(2, '0');
    const m = (min % 60).toString().padStart(2, '0');
    return `${h}:${m}`;
};

async function getOpeningForDate(dateObj) {
    const weekdayMap = ["Sonntag","Montag","Dienstag","Mittwoch","Donnerstag","Freitag","Samstag"];
    const germanWeekday = weekdayMap[dateObj.jsDate.getDay()];

    try {
        // Exceptions prüfen mit deutschem Format
        const exRes = await axios.get(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${OPENING_EXCEPTIONS_TABLE}`, {
            headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
            params: { filterByFormula: `{date}='${dateObj.german}'` }
        });

        if (exRes.data.records.length > 0) {
            const ex = exRes.data.records[0].fields;
            if (ex.closed) return { closed: true };
            return { closed: false, open: ex.open_time, close: ex.close_time };
        }

        const hoursRes = await axios.get(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${OPENING_HOURS_TABLE}`, {
            headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
            params: { filterByFormula: `{weekday}="${germanWeekday}"` }
        });

        if (hoursRes.data.records.length === 0) return { closed: true };
        const f = hoursRes.data.records[0].fields;
        return { closed: false, open: f.open_time, close: f.close_time };
    } catch (e) {
        console.error("Airtable Error:", e.message);
        return { closed: true };
    }
}

// ========================
// ROUTES
// ========================

app.post("/check-availability", async (req, res) => {
    try {
        const args = req.body.message?.toolCalls?.[0]?.function?.arguments || req.body;
        const dateObj = getFormattedDate(args.date);
        const reqMin = timeToMinutes(args.time_text);
        const numGuests = parseInt(args.guests || 1, 10);

        const opening = await getOpeningForDate(dateObj);
        if (opening.closed) return res.json({ success: true, available: false, message: "Geschlossen." });

        const openMin = timeToMinutes(opening.open);
        const closeMin = timeToMinutes(opening.close);

        if (reqMin < openMin || (reqMin + 30) > closeMin) {
            return res.json({ success: true, available: false, message: "Außerhalb der Öffnungszeiten." });
        }

        const resRecords = await axios.get(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${RESERVATIONS_TABLE}`, {
            headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
            params: { filterByFormula: `AND({date}='${dateObj.german}', {status}='bestätigt')` }
        });

        let currentLoad = 0;
        resRecords.data.records.forEach(r => {
            const start = timeToMinutes(r.fields.time_text);
            if (reqMin < (start + SLOT_DURATION_MIN) && (reqMin + SLOT_DURATION_MIN) > start) {
                currentLoad += (parseInt(r.fields.guests) || 0);
            }
        });

        const isAvailable = (currentLoad + numGuests) <= MAX_CAPACITY;
        return res.json({ success: true, available: isAvailable });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post("/create-reservation", async (req, res) => {
    try {
        const args = req.body.message?.toolCalls?.[0]?.function?.arguments || req.body;
        const { date, time_text, guests, name } = args;
        const phone = extractPhone(req);
        const normalizedDate = normalizeDate(date);
        
        const reqMin = timeToMinutes(time_text);
        const startISO = `${normalizedDate}T${time_text}:00.000Z`;
        const endISO = `${normalizedDate}T${toHHMM(reqMin + SLOT_DURATION_MIN)}:00.000Z`;

        await axios.post(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${RESERVATIONS_TABLE}`, {
            fields: {
                date: normalizedDate,
                time_text,
                guests: parseInt(guests || 1, 10),
                name,
                phone,
                status: "bestätigt",
                start_datetime: startISO,
                end_datetime: endISO
            }
        }, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });

        return res.json({ success: true });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
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