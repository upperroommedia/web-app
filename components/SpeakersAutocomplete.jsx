import { createElement, Fragment, useEffect, useRef, useState } from 'react';
import { usePagination, useSearchBox } from 'react-instantsearch-hooks';
import { autocomplete } from '@algolia/autocomplete-js';

import { createRoot } from 'react-dom/client';

import '@algolia/autocomplete-theme-classic';

// eslint-disable-next-line react/prop-types
export function SpeakersAutocomplete({ className, ...autocompleteProps }) {
  const autocompleteContainer = useRef(null);
  const panelRootRef = useRef(null);
  const rootRef = useRef(null);

  const { query, refine: setQuery } = useSearchBox();
  const { refine: setPage } = usePagination();

  const [instantSearchUiState, setInstantSearchUiState] = useState({ query });

  useEffect(() => {
    setQuery(instantSearchUiState.query);
    setPage(0);
  }, [instantSearchUiState]);

  useEffect(() => {
    if (!autocompleteContainer.current) {
      return;
    }

    const autocompleteInstance = autocomplete({
      ...autocompleteProps,
      container: autocompleteContainer.current,
      initialState: { query },
      onReset() {
        setInstantSearchUiState({ query: '' });
      },
      onSubmit({ state }) {
        setInstantSearchUiState({ query: state.query });
      },
      onStateChange({ prevState, state }) {
        if (prevState.query !== state.query) {
          setInstantSearchUiState({
            query: state.query,
          });
        }
      },
      renderer: { createElement, Fragment, render: () => {} },
      render({ children }, root) {
        if (!panelRootRef.current || rootRef.current !== root) {
          rootRef.current = root;

          panelRootRef.current?.unmount();
          panelRootRef.current = createRoot(root);
        }

        panelRootRef.current.render(children);
      },
    });

    return () => autocompleteInstance.destroy();
  }, []);

  return <div className={className} ref={autocompleteContainer} />;
}

export default SpeakersAutocomplete;
