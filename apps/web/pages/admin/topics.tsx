import { ChangeEvent, useDeferredValue, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useCollectionData } from 'react-firebase-hooks/firestore';
import firestore, { collection, query, orderBy } from '../../firebase/firestore';
import AppLayout from '../../layout/AppLayout';
import TopicTable from '../../components/TopicTable';
import useAuth from '../../context/user/UserContext';
import { Order } from '../../context/types';
import { topicConverter, Topic } from '../../types/Topic';

const AdminTopics = () => {
  const topicsQuery = useMemo(
    () => query(collection(firestore, 'topics').withConverter(topicConverter), orderBy('title')),
    []
  );
  const [topics, loading, error] = useCollectionData(topicsQuery);
  const [searchValue, setSearchValue] = useState<string>('');
  const deferredSearchValue = useDeferredValue(searchValue);
  const [page, setPage] = useState<number>(0);
  const [rowsPerPage, setRowsPerPage] = useState<number>(25);
  const [sortProperty, setSortProperty] = useState<keyof Topic>('title');
  const [sortOrder, setSortOrder] = useState<Order>('asc');

  const filteredTopics = useMemo(() => {
    const normalizedSearchValue = deferredSearchValue.trim().toLowerCase();
    const visibleTopics = normalizedSearchValue
      ? (topics ?? []).filter((topic) => topic.title.toLowerCase().includes(normalizedSearchValue))
      : topics ?? [];

    return [...visibleTopics].sort((leftTopic, rightTopic) => {
      const leftValue = leftTopic[sortProperty];
      const rightValue = rightTopic[sortProperty];

      if (typeof leftValue === 'number' && typeof rightValue === 'number') {
        return sortOrder === 'asc' ? leftValue - rightValue : rightValue - leftValue;
      }

      const normalizedLeft = String(leftValue ?? '').toLowerCase();
      const normalizedRight = String(rightValue ?? '').toLowerCase();
      const comparison = normalizedLeft.localeCompare(normalizedRight);
      return sortOrder === 'asc' ? comparison : -comparison;
    });
  }, [deferredSearchValue, sortOrder, sortProperty, topics]);

  const paginatedTopics = useMemo(
    () => filteredTopics.slice(page * rowsPerPage, page * rowsPerPage + rowsPerPage),
    [filteredTopics, page, rowsPerPage]
  );

  const handleSort = async (property: keyof Topic, order: Order) => {
    setSortProperty(property);
    setSortOrder(order);
    setPage(0);
  };

  const handlePageChange = async (newPage: number) => {
    setPage(newPage);
  };

  const handleChangeRowsPerPage = async (event: ChangeEvent<HTMLInputElement>) => {
    setRowsPerPage(parseInt(event.target.value, 10));
    setPage(0);
  };

  return (
    <Box sx={{ maxWidth: 1200, mx: 'auto', width: '100%' }}>
      {error ? (
        <Box sx={{ textAlign: 'center', py: 4 }}>
          <Typography color="error">{`Error: ${error.message}`}</Typography>
        </Box>
      ) : (
        <TopicTable
          topics={paginatedTopics}
          page={page}
          rowsPerPage={rowsPerPage}
          totalTopics={filteredTopics.length}
          sortOrder={sortOrder}
          sortProperty={sortProperty}
          searchValue={searchValue}
          loading={loading}
          handlePageChange={handlePageChange}
          handleChangeRowsPerPage={handleChangeRowsPerPage}
          handleSort={handleSort}
          onSearchChange={(value) => {
            setSearchValue(value);
            setPage(0);
          }}
        />
      )}
    </Box>
  );
};

const ProtectedAdminTopics = () => {
  const { user } = useAuth();

  if (!user?.isAdmin()) {
    return null;
  }

  return <AdminTopics />;
};

ProtectedAdminTopics.PageLayout = AppLayout;

export default ProtectedAdminTopics;
