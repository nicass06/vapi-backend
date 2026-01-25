const express = require("express");
const axios = require("axios");
const app = express();
app.use(express.json());

// Umgebungsvariablen
const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const RESERVATIONS_TABLE = "Reservations";

// --- HILFSFUNKTIONEN ---

function normalizeDate(dateInput) {
    if (!dateInput) return null;
    const date = new Date(dateInput);
    if (isNaN(date.getTime())) return null;
    return date.toISOString().split('T')[0]; // YYYY-MM-DD
}

function extractPhone(req) {
    // 1. Suche in den Anruf-Metadaten (der sicherste Weg)
    const metadata = req.body.message?.call?.customer?.number || 
                     req.body.call?.customer?.number || 
                     req.body.customer?.number;
    
    if (metadata && metadata.length > 5 && !metadata.includes('{')) {
        return metadata;
    }

    // 2. Suche im Tool-Parameter
    const paramPhone = req.body.phone || req.body.message?.toolCalls?.[0]?.function?.arguments?.phone;
    if (paramPhone && paramPhone.length > 5 && !paramPhone.includes('{')) {
        return paramPhone;
    }

    return "Unbekannt";
}

// --- ROUTE 1: CHECK AVAILABILITY ---
app.post("/check-availability", async (req, res) => {
    try {
        const { date, guests } = req.body.message?.toolCalls?.[0]?.function?.arguments || req.body;
        const normalizedDate = normalizeDate(date);
        
        console.log(`--- CHECK START ---`);
        console.log(`Anfrage für: ${normalizedDate} für ${guests} Pers.`);

        const filter = `{date}='${normalizedDate}'`;
        const response = await axios.get(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${RESERVATIONS_TABLE}`, {
            headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
            params: { filterByFormula: filter }
        });

        const currentGuests = response.data.records.reduce((sum, record) => sum + (record.fields.guests || 0), 0);
        const capacity = 20; // Beispielkapazität
        const isAvailable = (currentGuests + parseInt(guests)) <= capacity;

        res.json({ success: true, isAvailable, remainingCapacity: capacity - currentGuests });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- ROUTE 2: CREATE RESERVATION ---
app.post("/create-reservation", async (req, res) => {
    try {
        const args = req.body.message?.toolCalls?.[0]?.function?.arguments || req.body;
        const phone = extractPhone(req);

        const newRecord = {
            fields: {
                name: args.name,
                date: normalizeDate(args.date),
                time_text: args.time,
                guests: parseInt(args.guests),
                phone: phone,
                status: "bestätigt"
            }
        };

        const response = await axios.post(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${RESERVATIONS_TABLE}`, newRecord, {
            headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, "Content-Type": "application/json" }
        });

        res.json({ success: true, reservation_id: response.data.id });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- ROUTE 3: GET RESERVATION BY PHONE (Für Stornierung) ---
app.post("/get-reservation-by-phone", async (req, res) => {
    try {
        const phone = extractPhone(req);
        const cleanPhone = phone.replace(/\s/g, '');
        
        console.log(`--- GET START ---`);
        console.log(`Suche nach Nummer: ${cleanPhone}`);

        const filter = `AND(SUBSTITUTE({phone}, ' ', '')='${cleanPhone}', {status}='bestätigt')`;
        
        const search = await axios.get(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${RESERVATIONS_TABLE}`, {
            headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
            params: { filterByFormula: filter }
        });

        if (search.data.records.length === 0) {
            return res.json({ success: false, message: "Keine Reservierung gefunden." });
        }

        const resData = search.data.records[0].fields;
        res.json({ 
            success: true, 
            reservation_id: search.data.records[0].id,
            date: resData.date,
            time: resData.time_text,
            name: resData.name
        });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// --- ROUTE 4: CANCEL RESERVATION ---
app.post("/cancel-reservation", async (req, res) => {
    try {
        const reservation_id = req.body.reservation_id || 
                               req.body.message?.toolCalls?.[0]?.function?.arguments?.reservation_id;

        console.log(`--- CANCEL START ---`);

        if (!reservation_id) return res.json({ success: false, message: "Keine ID erhalten." });

        await axios.patch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${RESERVATIONS_TABLE}/${reservation_id}`, 
            { fields: { status: "storniert" } },
            { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, "Content-Type": "application/json" } }
        );

        res.json({ success: true, message: "Reservierung storniert." });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));