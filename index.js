import express from "express";
import axios from "axios";
import cors from "cors";
import moment from "moment";

const app = express();
app.use(cors());
app.use(express.json());

const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const RESERVATIONS_TABLE = "Reservations";
const OPENING_HOURS_TABLE = "opening_hours";
const OPENING_EXCEPTIONS_TABLE = "opening_exceptions";

// ========================
// FESTE KONFIGURATION IM CODE
// ========================
const MAX_CAPACITY = 10;
const SLOT_DURATION_MIN = 120; // Die 120 Minuten wieder fest im Code

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

// ========================
// ROUTES
// ========================

app.post("/check-availability", async (req, res) => {
    try {
        const { date, time_text } = req.body;
        
        // 1. Zeitberechnung für Überschneidungen mit festen Werten
        const requestedStart = moment(`${date} ${time_text}`, "YYYY-MM-DD HH:mm");
        const requestedEnd = moment(requestedStart).add(SLOT_DURATION_MIN, 'minutes');

        // 2. Alle bestätigten Reservierungen für diesen Tag holen
        const reservationSearch = await axios.get(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${RESERVATIONS_TABLE}`, {
            headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
            params: { 
                filterByFormula: `AND({date}='${date}', {status}='bestätigt')` 
            }
        });

        // 3. Prüfen, wie viele Reservierungen sich zeitlich überschneiden
        const overlappingBookings = reservationSearch.data.records.filter(record => {
            const bookingStart = moment(`${record.fields.date} ${record.fields.time_text}`, "YYYY-MM-DD HH:mm");
            const bookingEnd = moment(bookingStart).add(SLOT_DURATION_MIN, 'minutes');

            // Überschneidungs-Logik: (StartA < EndeB) UND (EndeA > StartB)
            return (requestedStart < bookingEnd) && (requestedEnd > bookingStart);
        });

        const currentLoad = overlappingBookings.length;

        if (currentLoad < MAX_CAPACITY) {
            return res.json({ 
                success: true, 
                remaining: MAX_CAPACITY - currentLoad,
                duration: SLOT_DURATION_MIN 
            });
        } else {
            return res.json({ success: false, message: "In diesem Zeitraum sind leider alle Tische belegt." });
        }
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
        const reqMin = timeToMinutes(time_text);

        const startISO = `${normalizedDate}T${time_text}:00.000Z`;
        const endISO = `${normalizedDate}T${toHHMM(reqMin + SLOT_DURATION_MIN)}:00.000Z`;

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
        
        const filter = `AND(NOT({phone} = ''), SEARCH('${cleanPhone}', SUBSTITUTE({phone}, ' ', '')), {status}='bestätigt')`;

        const search = await axios.get(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${RESERVATIONS_TABLE}`, {
            headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
            params: { 
                filterByFormula: filter,
                sort: [{ field: "date", direction: "desc" }]
            }
        });

        if (search.data.records.length === 0) return res.json({ success: false });

        const record = search.data.records[0];
        return res.json({
            success: true,
            reservation_id: record.id,
            date: record.fields.date,
            time: record.fields.time_text,
            name: record.fields.name
        });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

app.post("/cancel-reservation", async (req, res) => {
    try {
        const reservation_id = req.body.reservation_id || 
                               req.body.message?.toolCalls?.[0]?.function?.arguments?.reservation_id;

        if (!reservation_id) return res.json({ success: false, message: "ID fehlt" });

        await axios.patch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${RESERVATIONS_TABLE}/${reservation_id}`, 
            { fields: { status: "storniert" } },
            { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, "Content-Type": "application/json" } }
        );

        return res.json({ success: true });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));