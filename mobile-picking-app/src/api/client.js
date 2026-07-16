import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';

const API_BASE_URL = process.env.REACT_APP_API_URL || 'http://localhost:3000';

const apiClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json'
  }
});

// Intercept requests to add token
apiClient.interceptors.request.use(
  async (config) => {
    const token = await AsyncStorage.getItem('authToken');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// Intercept responses to handle errors
apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (error.response?.status === 401) {
      // Clear auth and redirect to login
      await AsyncStorage.removeItem('authToken');
      await AsyncStorage.removeItem('user');
    }
    return Promise.reject(error);
  }
);

export const ApiClient = {
  setToken: (token) => {
    if (token) {
      apiClient.defaults.headers.common['Authorization'] = `Bearer ${token}`;
    } else {
      delete apiClient.defaults.headers.common['Authorization'];
    }
  },

  get: (url, config) => apiClient.get(url, config),
  post: (url, data, config) => apiClient.post(url, data, config),
  put: (url, data, config) => apiClient.put(url, data, config),
  delete: (url, config) => apiClient.delete(url, config),

  // Picking API methods
  getPickingWaves: () => apiClient.get('/api/picking-waves'),
  getWaveDetails: (waveId) => apiClient.get(`/api/picking-waves/${waveId}`),
  getPickItems: (waveId) => apiClient.get(`/api/picking-waves/${waveId}/items`),
  markItemPicked: (waveId, itemId, qty) =>
    apiClient.post(`/api/picking-waves/${waveId}/items/${itemId}/pick`, { qty }),
  validatePick: (waveId, itemId, qty, sku) =>
    apiClient.post('/api/picking-waves/validate', { waveId, itemId, qty, sku }),

  // Carton API methods
  getCartons: (waveId) => apiClient.get(`/api/cartons?waveId=${waveId}`),
  createCarton: (waveId, data) => apiClient.post(`/api/cartons`, { ...data, waveId }),
  assignItemToCarton: (cartonId, itemId, qty) =>
    apiClient.post(`/api/cartons/${cartonId}/items`, { itemId, qty }),
  finalizeCarton: (cartonId) => apiClient.post(`/api/cartons/${cartonId}/finalize`),
  generateLabel: (cartonId) => apiClient.get(`/api/cartons/${cartonId}/label`),

  // Stats API methods
  getPickingStats: () => apiClient.get('/api/analytics/picking-stats'),
  getStaffPerformance: (staffId) => apiClient.get(`/api/analytics/staff/${staffId}`),
  getWaveProgress: (waveId) => apiClient.get(`/api/analytics/wave/${waveId}`),

  // Warehouse API methods
  getWarehouses: () => apiClient.get('/api/warehouses'),
  getAllocatedOrders: () => apiClient.get('/api/orders?status=allocated')
};

export default apiClient;
