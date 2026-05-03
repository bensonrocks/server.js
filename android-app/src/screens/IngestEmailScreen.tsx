import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  StyleSheet, KeyboardAvoidingView, Platform, Alert,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../../App';
import { api } from '../api';
import { COLORS } from '../theme';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'IngestEmail'> };

const SAMPLE = `---ORDER-START---
ORDER_ID: ORD-2026-021
CLIENT_ID: acme-corp
CLIENT_NAME: Acme Corp
CHANNEL: email
ORDER_DATE: 2026-05-03T15:00:00Z
STATUS: confirmed
CURRENCY: USD
NOTES: Ingest test order

---ITEMS---
SKU|NAME|QTY|UNIT_PRICE
WIDGET-BLU|Blue Widget|2|29.99
DESK-PAD|Desk Pad XL|1|24.99

---SHIPPING---
RECIPIENT: Test Customer
ADDRESS_LINE1: 1 Example Street
ADDRESS_LINE2: Unit 7
CITY: San Francisco
STATE: CA
ZIP: 94102
COUNTRY: US

---TOTALS---
SUBTOTAL: 84.97
SHIPPING: 5.99
TAX: 7.65
TOTAL: 98.61
---ORDER-END---`;

export default function IngestEmailScreen({ navigation }: Props) {
  const [from, setFrom]       = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody]       = useState('');
  const [error, setError]     = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    if (!body.trim()) { setError('Email body is required.'); return; }
    setError('');
    setLoading(true);
    try {
      const order = await api.ingestEmail({ body: body.trim(), subject, from });
      Alert.alert(
        'Order Added ✓',
        `${order.id} from ${order.clientName} was successfully ingested.`,
        [{ text: 'View Order', onPress: () => navigation.replace('OrderDetail', { orderId: order.id }) },
         { text: 'Done', onPress: () => navigation.goBack() }],
      );
    } catch (e: any) {
      setError(e.message || 'Failed to parse email');
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView style={s.container} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">

        <Text style={s.hint}>
          Paste a standardised order email. Must include{' '}
          <Text style={s.code}>---ORDER-START---</Text> and{' '}
          <Text style={s.code}>---ORDER-END---</Text> markers.
        </Text>

        <View style={s.field}>
          <Text style={s.label}>FROM</Text>
          <TextInput style={s.input} value={from} onChangeText={setFrom}
            placeholder="orders@client.com" placeholderTextColor={COLORS.muted}
            autoCapitalize="none" keyboardType="email-address" />
        </View>

        <View style={s.field}>
          <Text style={s.label}>SUBJECT</Text>
          <TextInput style={s.input} value={subject} onChangeText={setSubject}
            placeholder="[ECOM-ORDER] client | ORD-XXXX | channel"
            placeholderTextColor={COLORS.muted} />
        </View>

        <View style={s.field}>
          <Text style={s.label}>EMAIL BODY</Text>
          <TextInput
            style={s.bodyInput}
            value={body}
            onChangeText={setBody}
            multiline
            placeholder="Paste email body here…"
            placeholderTextColor={COLORS.muted}
            autoCapitalize="none"
            autoCorrect={false}
            textAlignVertical="top"
          />
        </View>

        <TouchableOpacity style={s.sampleBtn} onPress={() => { setBody(SAMPLE); setFrom('orders@acme-corp.com'); setSubject('[ECOM-ORDER] acme-corp | ORD-2026-021 | email'); }}>
          <Text style={s.sampleBtnText}>Load Sample Email</Text>
        </TouchableOpacity>

        {error ? (
          <View style={s.errorBox}>
            <Text style={s.errorText}>⚠ {error}</Text>
          </View>
        ) : null}

        <TouchableOpacity
          style={[s.submitBtn, loading && s.submitBtnDisabled]}
          onPress={submit}
          disabled={loading}
        >
          <Text style={s.submitBtnText}>{loading ? 'Parsing…' : 'Parse & Add Order'}</Text>
        </TouchableOpacity>

      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  content:   { padding: 16, paddingBottom: 40 },

  hint: { fontSize: 13, color: COLORS.muted, lineHeight: 19, marginBottom: 16 },
  code: { fontFamily: 'monospace', fontSize: 11, backgroundColor: '#f1f5f9', color: COLORS.dark },

  field:  { marginBottom: 14 },
  label:  { fontSize: 10, fontWeight: '800', color: COLORS.muted, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 5 },
  input:  {
    backgroundColor: COLORS.surface, borderRadius: 10, paddingHorizontal: 12,
    paddingVertical: 10, fontSize: 14, color: COLORS.text,
    borderWidth: 1.5, borderColor: COLORS.border,
  },
  bodyInput: {
    backgroundColor: COLORS.surface, borderRadius: 10, paddingHorizontal: 12,
    paddingTop: 10, fontSize: 12, fontFamily: 'monospace', color: COLORS.text,
    borderWidth: 1.5, borderColor: COLORS.border,
    minHeight: 240,
  },

  sampleBtn:     { borderWidth: 1.5, borderColor: COLORS.border, borderRadius: 8, paddingVertical: 9, alignItems: 'center', marginBottom: 14, backgroundColor: COLORS.surface },
  sampleBtnText: { fontSize: 13, fontWeight: '600', color: COLORS.muted },

  errorBox:  { backgroundColor: '#fee2e2', borderRadius: 8, padding: 12, marginBottom: 14, borderWidth: 1, borderColor: '#fca5a5' },
  errorText: { fontSize: 13, color: '#991b1b', lineHeight: 18 },

  submitBtn:         { backgroundColor: COLORS.accent, borderRadius: 10, paddingVertical: 14, alignItems: 'center' },
  submitBtnDisabled: { opacity: 0.6 },
  submitBtnText:     { color: '#fff', fontSize: 15, fontWeight: '700' },
});
