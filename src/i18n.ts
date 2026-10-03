import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

i18n.use(initReactI18next).init({
  lng: 'zh',
  fallbackLng: 'zh',
  resources: {
    zh: { translation: { title: '帆船赛现场控制台', control: '竞赛控制', results: '成绩管理', protests: '抗议与申诉', language: 'English' } },
    en: { translation: { title: 'Regatta Control Desk', control: 'Race control', results: 'Results', protests: 'Protests', language: '中文' } }
  }
});

export default i18n;
