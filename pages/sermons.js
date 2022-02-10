/**
 * Sermons page for viewing all sermons
 */
import Footer from "../components/Footer";
import Navbar from "../components/Navbar";
import styles from "../styles/Home.module.css";

function Sermons() {
  return (
    <div className={styles.container}>
      <Navbar />
      <h1>Sermons</h1>
      <Footer />
    </div>
  );
}

export default Sermons;
