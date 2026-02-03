import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { initializeI18n, setLanguage, getSystemLocale, AVAILABLE_LANGUAGES } from './i18n';
import i18n from './i18n';

interface LanguageContextType {
  currentLanguage: string; // 'system', 'en', 'es'
  locale: string; // actual locale being used: 'en' or 'es'
  isLoading: boolean;
  changeLanguage: (languageCode: string) => Promise<void>;
  t: (key: string, options?: Record<string, unknown>) => string;
  availableLanguages: typeof AVAILABLE_LANGUAGES;
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

interface LanguageProviderProps {
  children: ReactNode;
}

export const LanguageProvider: React.FC<LanguageProviderProps> = ({ children }) => {
  const [currentLanguage, setCurrentLanguage] = useState<string>('system');
  const [locale, setLocale] = useState<string>('en');
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const init = async () => {
      try {
        const savedLanguage = await initializeI18n();
        setCurrentLanguage(savedLanguage);
        setLocale(i18n.locale);
      } catch (error) {
        console.error('Error initializing i18n:', error);
      } finally {
        setIsLoading(false);
      }
    };
    init();
  }, []);

  const changeLanguage = useCallback(async (languageCode: string) => {
    try {
      await setLanguage(languageCode);
      setCurrentLanguage(languageCode);
      if (languageCode === 'system') {
        setLocale(getSystemLocale());
      } else {
        setLocale(languageCode);
      }
    } catch (error) {
      console.error('Error changing language:', error);
    }
  }, []);

  const t = useCallback((key: string, options?: Record<string, unknown>): string => {
    return i18n.t(key, options);
  }, [locale]); // eslint-disable-line react-hooks/exhaustive-deps

  const value: LanguageContextType = {
    currentLanguage,
    locale,
    isLoading,
    changeLanguage,
    t,
    availableLanguages: AVAILABLE_LANGUAGES,
  };

  return (
    <LanguageContext.Provider value={value}>
      {children}
    </LanguageContext.Provider>
  );
};

export const useLanguage = (): LanguageContextType => {
  const context = useContext(LanguageContext);
  if (context === undefined) {
    throw new Error('useLanguage must be used within a LanguageProvider');
  }
  return context;
};

export default LanguageContext;
