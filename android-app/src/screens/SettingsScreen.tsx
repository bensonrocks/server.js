import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, Alert, ActivityIndicator,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../../App';
import { saveBaseUrl, getBaseUrl, api } from '../api';
import { COLORS } from '../theme';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'Settings'> };

export default function SettingsScreen({ navigation }: Props) {
  const [url, setUrl]         = useState(getBaseUrl());
  const [testing, setTesting] = useState(false);

  const save = async () => {
    const trimmed = url.trim().replace(/\/$/, '');
    if (!trimmed) { Alert.alert('Invalid URL', 'Please enter a valid server URL.'); return; }
    await saveBaseUrl(trimmed);
    Alert.alert('Saved', 'Server URL updated.', [{ text: 'OK', onPress: () => navigation.goBack() }]);
  };

  const test = async () => {
    setTesting(true);
    try {
      const stats = await api.getStats();
      Alert.alert('Connected ✓', `Found ${stats.totalOrders} orders across ${stats.totalClients} clients.`);
    } catch (e: any) {
      Alert.alert('Connection failed', e.message || 'Could not reach server.');
    } finally {
      setTesting(false);
    }
  };

  return (
    <View style={s.container}>

      <View style={s.card}>
        <Text style={s.cardTitle}>Server URL</Text>
        <Text style={s.cardHint}>
          The address of your Node.js order server.{'\n'}
          Android emulator → <Text style={s.mono}>http://10.0.2.2:3000</Text>{'\n'}
          Real device on same Wi-Fi → <Text style={s.mono}>http://192.168.x.x:3000</Text>
        </Text>
        <TextInput
          style={s.input}
          value={url}
          onChangeText={setUrl}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="done"
          placeholder="http://10.0.2.2:3000"
          placeholderTextColor={COLORS.muted}
        />

        <TouchableOpacity style={s.testBtn} onPress={test} disabled={testing}>
          {testing
            ? <ActivityIndicator size="small" color={COLORS.accent} />
            : <Text style={s.testBtnText}>Test Connection</Text>
          }
        </TouchableOpacity>
      </View>

      <TouchableOpacity style={s.saveBtn} onPress={save}>
        <Text style={s.saveBtnText}>Save Settings</Text>
      </TouchableOpacity>

      <View style={s.infoCard}>
        <Text style={s.infoTitle}>Email Format</Text>
        <Text style={s.infoText}>
          Clients send orders in this standardised format via email.
          Your admin can paste them in the Ingest Email screen.
        </Text>
        <Text style={s.codeBlock}>
          {'---ORDER-START---\nORDER_ID: ORD-XXXX\nCLIENT_ID: my-client\nCLIENT_NAME: My Client\nCHANNEL: email\n...\n---ORDER-END---'}
        </Text>
      </View>

    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg, padding: 16 },

  card: {
    backgroundColor: COLORS.surface, borderRadius: 12, padding: 16,
    marginBottom: 12, elevation: 2,
  },
  cardTitle: { fontSize: 14, fontWeight: '700', color: COLORS.text, marginBottom: 8 },
  cardHint:  { fontSize: 12, color: COLORS.muted, lineHeight: 18, marginBottom: 12 },
  mono:      { fontFamily: 'monospace', fontSize: 11 },

  input: {
    borderWidth: 1.5, borderColor: COLORS.border, borderRadius: 8,
    paddingHorizontal: 12, paddingVertical: 10, fontSize: 14,
    color: COLORS.text, backgroundColor: COLORS.bg, marginBottom: 10,
  },

  testBtn:     { borderWidth: 1.5, borderColor: COLORS.accent, borderRadius: 8, paddingVertical: 9, alignItems: 'center', height: 40, justifyContent: 'center' },
  testBtnText: { color: COLORS.accent, fontSize: 13, fontWeight: '700' },

  saveBtn:     { backgroundColor: COLORS.accent, borderRadius: 10, paddingVertical: 14, alignItems: 'center', marginBottom: 16 },
  saveBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },

  infoCard:   { backgroundColor: COLORS.surface, borderRadius: 12, padding: 16, elevation: 1 },
  infoTitle:  { fontSize: 13, fontWeight: '700', color: COLORS.text, marginBottom: 6 },
  infoText:   { fontSize: 12, color: COLORS.muted, lineHeight: 17, marginBottom: 10 },
  codeBlock:  {
    backgroundColor: '#0f172a', borderRadius: 8, padding: 12,
    fontSize: 11, fontFamily: 'monospace', color: '#94a3b8', lineHeight: 17,
  },
});
