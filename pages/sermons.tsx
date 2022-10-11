/**
 * Sermons page for viewing all sermons test
 */
import type { GetServerSideProps, NextPage } from 'next';
// import PropTypes from 'prop-types';

import { Sermon } from '../types/Sermon';

interface Props {
  sermons: Sermon[];
}

const Sermons: NextPage<Props> = ({ sermons }: Props) => {

  // const handleSermonClick = (sermon: Sermon) => {
  //   // console.log('handle click');
  //   // setCurrentSermon(sermon);
  // };

  return (
    <>
      <div style={{ padding: '0 2rem' }}>
        <h1>Sermons</h1>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            margin: 'auto',
            maxWidth: '1000px',
            // gap: '3px',
          }}
        >
          {sermons}
        </div>
      </div>
    </>
  );
};

export const getServerSideProps: GetServerSideProps = async (context) => {
    // const db = getFirestore(firebase);
    // // Firestore data converter to convert the queried data to the expected type
    // //
    // const sermonsQuery = query(collection(db, 'sermons'), limit(3)).withConverter(sermonConverter);
    // const sermonsQuerySnapshot = await getDocs(sermonsQuery);
    // const sermons = sermonsQuerySnapshot.docs.map((doc) => doc.data());

    return {
      props: { sermons: [] },
    };

};

export default Sermons;
