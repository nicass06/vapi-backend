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

const MAX_CAPACITY = parseInt(process.env.MAX_CAPACITY || "10");
const SLOT_DURATION_MIN = parseInt(process.env.SLOT_DURATION || "120");

// ========================
// HILFSFUNKTIONEN
// ========================

function extractPhone(req) {
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

// Rechnet "18:00" ODER Sekunden (57600) in Minuten um
const timeToMinutes = (timeVal) => {
    if (timeVal === undefined || timeVal === null) return 0;
    if (typeof timeVal === 'number') return Math.floor(timeVal / 60);
    if (typeof timeVal === 'string') {
        const parts = timeVal.split(":");
        if (parts.length < 2) return 0;
        return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
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
    const dateObj = new Date(dateISO);
    const germanWeekday = weekdayMap[dateObj.getDay()];
    
    console.log(`Prüfe Öffnungszeiten für: ${dateISO} (${germanWeekday})`);

    try {
        // 1. Exceptions (Feiertage)
        const exRes = await axios.get(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${OPENING_EXCEPTIONS_TABLE}`, {
            headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
            params: { filterByFormula: `{date}='${dateISO}'` }
        });

        if (exRes.data.records.length > 0) {
            const ex = exRes.data.records[0].fields;
            if (ex.closed) return { closed: true };
            return { closed: false, open: ex.open_time, close: ex.close_time };
        }

        // 2. Reguläre Zeiten (Filter vereinfacht, falls restaurant_id Probleme macht)
        const hoursRes = await axios.get(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${OPENING_HOURS_TABLE}`, {
            headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
            params: { filterByFormula: `{weekday}="${germanWeekday}"` }
        });

        if (hoursRes.data.records.length === 0) return { closed: true };
        
        const fields = hoursRes.data.records[0].fields;
        console.log(`Airtable liefert: ${fields.open_time} bis ${fields.close_time}`);
        return { closed: false, open: fields.open_time, close: fields.close_time };
    } catch (e) { 
        console.error("Fehler bei getOpeningForDate:", e.message);
        return { closed: true }; 
    }
}

// ========================
// ROUTES
// ========================

app.post("/check-availability", async (req, res) => {
    try {
        const args = req.body.message?.toolCalls?.[0]?.function?.arguments || req.body;
        const { date, time_text, guests } = args;
        
        const normalizedDate = normalizeDate(date);
        const reqMin = timeToMinutes(time_text);
        const numGuests = parseInt(guests || 1);

        // 1. Öffnungszeiten prüfen
        const opening = await getOpeningForDate(normalizedDate);
        if (opening.closed) {
            return res.json({ success: true, available: false, message: "Geschlossen." });
        }

        const openMin = timeToMinutes(opening.open);
        const closeMin = timeToMinutes(opening.close);

        if (reqMin < openMin || (reqMin + 30) > closeMin) {
            return res.json({ success: true, available: false, message: "Außerhalb der Öffnungszeiten." });
        }

        // 2. KAPAZITÄTS-CHECK (Die wichtige Korrektur)
        const resRecords = await axios.get(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${RESERVATIONS_TABLE}`, {
            headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
            params: { 
                filterByFormula: `AND({date}='${normalizedDate}', {status}='bestätigt')` 
            }
        });

        let currentLoad = 0;
        resRecords.data.records.forEach(record => {
            const start = timeToMinutes(record.fields.time_text);
            const end = start + SLOT_DURATION_MIN;
            
            // Prüfen, ob sich der Zeitraum mit der neuen Anfrage überschneidet
            if (reqMin < end && (reqMin + SLOT_DURATION_MIN) > start) {
                currentLoad += (parseInt(record.fields.guests) || 0);
            }
        });

        console.log(`Kapazitäts-Check für ${time_text}: Belegt: ${currentLoad} | Kapazität: ${MAX_CAPACITY} | Neue Gäste: ${numGuests}`);

        if (currentLoad + numGuests > MAX_CAPACITY) {
            console.log("ERGEBNIS: Ausgebucht!");
            return res.json({ 
                success: true, 
                available: false, 
                message: "Leider sind wir zu dieser Zeit bereits ausgebucht." 
            });
        }

        console.log("ERGEBNIS: Tisch frei!");
        return res.json({ success: true, available: true });

    } catch (err) { 
        console.error("Check Error:", err.message);
        res.json({ success: false, error: err.message }); 
    }
});

app.post("/create-reservation", async (req, res) => {
    try {
        const args = req.body.message?.toolCalls?.[0]?.function?.arguments || req.body;
        const { date, time_text, guests, name } = args;
        const phone = extractPhone(req);
        const normalizedDate = normalizeDate(date);
        
        // Berechnung für Start und Ende
        const reqMin = timeToMinutes(time_text);
        const startISO = `${normalizedDate}T${time_text}:00.000Z`;
        const endISO = `${normalizedDate}T${toHHMM(reqMin + SLOT_DURATION_MIN)}:00.000Z`;

        console.log(`Erstelle Reservierung: ${name} am ${normalizedDate} um ${time_text}`);

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
    } catch (err) { 
        console.error("Fehler beim Erstellen:", err.response?.data || err.message);
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