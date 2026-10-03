import React from 'react';
import ReactDOM from 'react-dom/client';
import { Provider } from 'react-redux';
import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import 'antd/dist/reset.css';
import './i18n';
import { store } from './store';
import { raceApi } from './api';
import App from './App';
import './styles.css';

store.dispatch(raceApi.endpoints.getOfficials.initiate());

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Provider store={store}>
      <ConfigProvider locale={zhCN} theme={{ token: { colorPrimary: '#075985', borderRadius: 10 } }}>
        <App />
      </ConfigProvider>
    </Provider>
  </React.StrictMode>
);
