import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
  Switch,
  TextInput
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const SettingsScreen = ({ user, onLogout }) => {
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [vibrateEnabled, setVibrateEnabled] = useState(true);
  const [apiUrl, setApiUrl] = useState(process.env.REACT_APP_API_URL || 'http://localhost:3000');
  const [editingUrl, setEditingUrl] = useState(false);

  const handleLogout = async () => {
    Alert.alert(
      'Logout',
      'Are you sure you want to logout?',
      [
        { text: 'Cancel', onPress: () => {} },
        {
          text: 'Logout',
          onPress: async () => {
            await onLogout();
          },
          style: 'destructive'
        }
      ]
    );
  };

  const handleSaveApiUrl = async () => {
    try {
      await AsyncStorage.setItem('apiUrl', apiUrl);
      setEditingUrl(false);
      Alert.alert('Saved', 'API URL updated');
    } catch (error) {
      Alert.alert('Error', 'Failed to save API URL');
    }
  };

  return (
    <ScrollView style={styles.container}>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>User Account</Text>
        <View style={styles.card}>
          <View style={styles.field}>
            <Text style={styles.label}>Name</Text>
            <Text style={styles.value}>{user?.name || 'Unknown'}</Text>
          </View>
          <View style={styles.field}>
            <Text style={styles.label}>Role</Text>
            <Text style={styles.value}>{user?.role || 'Staff'}</Text>
          </View>
          <View style={styles.field}>
            <Text style={styles.label}>Warehouse</Text>
            <Text style={styles.value}>{user?.warehouseId || 'wh-main'}</Text>
          </View>
          <TouchableOpacity
            style={styles.dangerButton}
            onPress={handleLogout}
          >
            <Text style={styles.dangerButtonText}>Logout</Text>
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Notifications</Text>
        <View style={styles.card}>
          <View style={styles.toggleField}>
            <Text style={styles.label}>Enable Notifications</Text>
            <Switch
              value={notificationsEnabled}
              onValueChange={setNotificationsEnabled}
              trackColor={{ false: '#ccc', true: '#0066cc' }}
            />
          </View>
          <View style={styles.toggleField}>
            <Text style={styles.label}>Sound</Text>
            <Switch
              value={soundEnabled}
              onValueChange={setSoundEnabled}
              trackColor={{ false: '#ccc', true: '#0066cc' }}
              disabled={!notificationsEnabled}
            />
          </View>
          <View style={styles.toggleField}>
            <Text style={styles.label}>Vibration</Text>
            <Switch
              value={vibrateEnabled}
              onValueChange={setVibrateEnabled}
              trackColor={{ false: '#ccc', true: '#0066cc' }}
              disabled={!notificationsEnabled}
            />
          </View>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Network Settings</Text>
        <View style={styles.card}>
          <Text style={styles.label}>API Server URL</Text>
          {!editingUrl ? (
            <>
              <Text style={styles.value}>{apiUrl}</Text>
              <TouchableOpacity
                style={styles.primaryButton}
                onPress={() => setEditingUrl(true)}
              >
                <Text style={styles.buttonText}>Edit</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <TextInput
                style={styles.input}
                placeholder="API URL"
                value={apiUrl}
                onChangeText={setApiUrl}
              />
              <View style={styles.buttonRow}>
                <TouchableOpacity
                  style={[styles.button, styles.primaryButton]}
                  onPress={handleSaveApiUrl}
                >
                  <Text style={styles.buttonText}>Save</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.button, styles.secondaryButton]}
                  onPress={() => setEditingUrl(false)}
                >
                  <Text style={styles.buttonText}>Cancel</Text>
                </TouchableOpacity>
              </View>
            </>
          )}
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>About</Text>
        <View style={styles.card}>
          <View style={styles.field}>
            <Text style={styles.label}>App Version</Text>
            <Text style={styles.value}>1.0.0</Text>
          </View>
          <View style={styles.field}>
            <Text style={styles.label}>Build</Text>
            <Text style={styles.value}>001</Text>
          </View>
          <View style={styles.field}>
            <Text style={styles.label}>React Native</Text>
            <Text style={styles.value}>0.72.0</Text>
          </View>
        </View>
      </View>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
    padding: 10
  },
  section: {
    marginBottom: 20
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    marginBottom: 10,
    color: '#333'
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 8,
    padding: 15,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 3,
    elevation: 3
  },
  field: {
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0'
  },
  toggleField: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0'
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    color: '#333'
  },
  value: {
    fontSize: 14,
    color: '#666',
    marginTop: 5
  },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 5,
    padding: 10,
    marginVertical: 10,
    fontSize: 14
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 10
  },
  button: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 5,
    alignItems: 'center'
  },
  primaryButton: {
    backgroundColor: '#0066cc'
  },
  secondaryButton: {
    backgroundColor: '#ccc'
  },
  dangerButton: {
    backgroundColor: '#ff3333',
    paddingVertical: 12,
    borderRadius: 5,
    alignItems: 'center',
    marginTop: 15
  },
  buttonText: {
    color: '#fff',
    fontWeight: 'bold',
    fontSize: 14
  },
  dangerButtonText: {
    color: '#fff',
    fontWeight: 'bold',
    fontSize: 14
  }
});

export default SettingsScreen;
