import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  Alert,
  TextInput,
  ActivityIndicator
} from 'react-native';
import { ApiClient } from '../api/client';

const CartonScreen = () => {
  const [cartons, setCartons] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selectedCarton, setSelectedCarton] = useState(null);
  const [cartonNumber, setCartonNumber] = useState('');
  const [waveId, setWaveId] = useState('');

  useEffect(() => {
    loadCartons();
  }, [waveId]);

  const loadCartons = async () => {
    try {
      setLoading(true);
      if (!waveId) {
        setCartons([]);
        return;
      }
      const response = await ApiClient.getCartons(waveId);
      setCartons(response.data.cartons || []);
    } catch (error) {
      Alert.alert('Error', 'Failed to load cartons: ' + error.message);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateCarton = async () => {
    if (!waveId || !cartonNumber) {
      Alert.alert('Validation', 'Enter wave ID and carton number');
      return;
    }

    try {
      await ApiClient.createCarton(waveId, {
        cartonNumber,
        maxQty: 50
      });
      setCartonNumber('');
      await loadCartons();
      Alert.alert('Success', 'Carton created');
    } catch (error) {
      Alert.alert('Error', 'Failed to create carton: ' + error.message);
    }
  };

  const handleFinalizeCarton = async (cartonId) => {
    try {
      await ApiClient.finalizeCarton(cartonId);
      await loadCartons();
      Alert.alert('Success', 'Carton finalized');
    } catch (error) {
      Alert.alert('Error', 'Failed to finalize: ' + error.message);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TextInput
          style={styles.waveInput}
          placeholder="Enter Wave ID"
          value={waveId}
          onChangeText={setWaveId}
        />
      </View>

      <View style={styles.createSection}>
        <TextInput
          style={styles.input}
          placeholder="Carton #"
          value={cartonNumber}
          onChangeText={setCartonNumber}
        />
        <TouchableOpacity
          style={styles.createButton}
          onPress={handleCreateCarton}
        >
          <Text style={styles.buttonText}>+ Create Carton</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <ActivityIndicator size="large" color="#0066cc" />
      ) : (
        <FlatList
          data={cartons}
          keyExtractor={(c) => c.id}
          renderItem={({ item }) => (
            <View style={styles.cartonCard}>
              <View style={styles.cartonInfo}>
                <Text style={styles.cartonNumber}>Carton {item.cartonNumber}</Text>
                <Text style={styles.details}>Items: {item.lineCount} | Qty: {item.totalQty}/{item.maxQty}</Text>
                <Text style={styles.status}>Status: {item.status}</Text>
              </View>
              {item.status !== 'finalized' && (
                <TouchableOpacity
                  style={styles.actionButton}
                  onPress={() => handleFinalizeCarton(item.id)}
                >
                  <Text style={styles.buttonText}>Finalize</Text>
                </TouchableOpacity>
              )}
            </View>
          )}
          ListEmptyComponent={
            <Text style={styles.emptyText}>No cartons yet</Text>
          }
        />
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5'
  },
  header: {
    backgroundColor: '#0066cc',
    padding: 15
  },
  waveInput: {
    backgroundColor: '#fff',
    borderRadius: 5,
    padding: 10,
    fontSize: 14
  },
  createSection: {
    backgroundColor: '#fff',
    padding: 15,
    flexDirection: 'row',
    gap: 10
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 5,
    padding: 10,
    fontSize: 14
  },
  createButton: {
    backgroundColor: '#00cc00',
    paddingHorizontal: 15,
    borderRadius: 5,
    justifyContent: 'center'
  },
  cartonCard: {
    backgroundColor: '#fff',
    margin: 10,
    padding: 15,
    borderRadius: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderLeftWidth: 4,
    borderLeftColor: '#ff9900'
  },
  cartonInfo: {
    flex: 1
  },
  cartonNumber: {
    fontSize: 16,
    fontWeight: 'bold'
  },
  details: {
    fontSize: 12,
    color: '#666',
    marginTop: 5
  },
  status: {
    fontSize: 12,
    color: '#999',
    marginTop: 3
  },
  actionButton: {
    backgroundColor: '#0066cc',
    paddingHorizontal: 15,
    paddingVertical: 8,
    borderRadius: 5
  },
  buttonText: {
    color: '#fff',
    fontWeight: 'bold',
    fontSize: 12
  },
  emptyText: {
    textAlign: 'center',
    marginTop: 20,
    color: '#999'
  }
});

export default CartonScreen;
